//! Claude subscription transport.
//!
//! fx does not talk to `api.anthropic.com` on this route. It spawns the local
//! Claude Code binary in headless stream-json mode and translates that session
//! into one fx model step. Claude Code owns the subscription credential, so no
//! token is read, stored, or sent by fx.
//!
//! One process per model step: fx replays the whole conversation each time
//! rather than resuming a Claude Code session. Assistant-turn replay was
//! verified against Claude Code 2.1.257, and Claude Code's own prompt caching
//! absorbs most of the cost of re-sending context.

const std = @import("std");
const builtin = @import("builtin");
const credentials = @import("../core/auth/credentials.zig");
const claude_models = @import("anthropic_claude_models.zig");
const protocol = @import("claude_code_protocol.zig");
const tool_bridge = @import("claude_tool_bridge.zig");
const stream_provider = @import("../core/agent/stream_provider.zig");
const io_mod = @import("../core/shared/io.zig");
const debug_trace = @import("../core/shared/debug_trace.zig");
const types = @import("../core/shared/types.zig");

const Allocator = std.mem.Allocator;

/// Claude Code's init line alone can run to tens of kilobytes once a user has
/// many skills and MCP servers, so lines get a generous ceiling.
const line_buffer_bytes: usize = 1024 * 1024;
const max_stderr_bytes: usize = 64 * 1024;

/// Claude Code's own tools are stripped: fx owns tool execution, permissions,
/// and the transcript on this route. Anything Claude Code ran itself would
/// bypass all three.
/// Names captured from a real `--strict-mcp-config` init line; anything Claude
/// Code still offers after its MCP servers are stripped has to be named here or
/// it will call it. `ToolSearch` in particular gets reached for constantly.
const disallowed_builtin_tools =
    "Bash Read Write Edit MultiEdit NotebookEdit Glob Grep WebFetch WebSearch " ++
    "Task TodoWrite Skill SlashCommand KillShell BashOutput ExitPlanMode " ++
    "ToolSearch Workflow LSP ListAgents RemoteTrigger ReportFindings " ++
    "ScheduleWakeup SendMessage EnterWorktree ExitWorktree " ++
    "TaskCreate TaskGet TaskList TaskUpdate TaskOutput TaskStop " ++
    "CronCreate CronDelete CronList";

pub const agent_stream_provider = stream_provider.Provider{
    .stream_fn = streamClaude,
};

/// Bridges the protocol reader's callbacks onto fx's stream events so the
/// transcript renders while Claude Code is still producing output.
const EventBridge = struct {
    events: stream_provider.EventSink,

    fn onText(context: ?*anyopaque, text: []const u8) void {
        const self: *EventBridge = @ptrCast(@alignCast(context.?));
        self.events.emit(.{ .content_delta = text });
    }

    fn onReasoning(context: ?*anyopaque, text: []const u8) void {
        const self: *EventBridge = @ptrCast(@alignCast(context.?));
        self.events.emit(.{ .reasoning_delta = text });
    }

    fn onTool(context: ?*anyopaque, id: []const u8, name: []const u8) void {
        const self: *EventBridge = @ptrCast(@alignCast(context.?));
        self.events.emit(.{ .tool_started = .{ .id = id, .name = name } });
    }

    fn sink(self: *EventBridge) protocol.Sink {
        return .{
            .context = self,
            .on_text = onText,
            .on_reasoning = onReasoning,
            .on_tool = onTool,
        };
    }
};

/// Path Claude Code should spawn to reach fx's MCP tool bridge. This must be
/// the running binary — a stale `fx` on PATH could advertise a different tool
/// set than the one this turn was built from.
fn selfExecutable() []const u8 {
    if (io_mod.getenv("FX_SELF_EXE")) |value| {
        if (value.len > 0) return value;
    }
    return "/proc/self/exe";
}

fn failure(kind: stream_provider.FailureKind, detail: ?[]u8) stream_provider.Result {
    return .{ .failed = .{
        .kind = kind,
        .detail = detail,
        .ownership = if (detail == null) .borrowed else .owned,
    } };
}

/// Joins every system turn into the prompt Claude Code runs under. fx supplies
/// its own agent identity here; `--system-prompt` replaces Claude Code's.
fn buildSystemPrompt(alloc: Allocator, messages: []const types.ChatMessage) !?[]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();

    var wrote = false;
    for (messages) |message| {
        if (message.role != .system) continue;
        const text = message.content orelse continue;
        if (text.len == 0) continue;
        if (wrote) try out.writer.writeAll("\n\n");
        try out.writer.writeAll(text);
        wrote = true;
    }
    if (!wrote) {
        out.deinit();
        return null;
    }
    return try out.toOwnedSlice();
}

/// Holds fx's system prompt on disk for the life of one Claude Code run.
///
/// The prompt is passed as `--system-prompt-file`, not `--system-prompt`: fx's
/// prompt is large and multi-line, and every OS caps total argument size
/// (32 KiB on Windows). Passing it inline made Claude Code reject the
/// invocation outright with "Invalid argument".
const SystemPromptFile = struct {
    dir: std.Io.Dir,
    path: []u8,
    name: []u8,

    fn create(alloc: Allocator, prompt: []const u8) !SystemPromptFile {
        return createNamed(alloc, "system", prompt);
    }

    fn createNamed(alloc: Allocator, kind: []const u8, contents: []const u8) !SystemPromptFile {
        const temp_root = io_mod.getenv("TMPDIR") orelse
            io_mod.getenv("TMP") orelse
            io_mod.getenv("TEMP") orelse
            "/tmp";

        var dir = try std.Io.Dir.openDirAbsolute(io_mod.getIo(), temp_root, .{});
        errdefer dir.close(io_mod.getIo());

        const name = try std.fmt.allocPrint(
            alloc,
            "fx-claude-{s}-{d}-{d}.txt",
            .{ kind, currentProcessId(), io_mod.milliTimestamp() },
        );
        errdefer alloc.free(name);

        var file = try dir.createFile(io_mod.getIo(), name, .{ .truncate = true });
        defer file.close(io_mod.getIo());
        try file.writeStreamingAll(io_mod.getIo(), contents);

        const path = try std.fs.path.join(alloc, &.{ temp_root, name });
        errdefer alloc.free(path);
        return .{ .dir = dir, .path = path, .name = name };
    }

    fn deinit(self: *SystemPromptFile, alloc: Allocator) void {
        self.dir.deleteFile(io_mod.getIo(), self.name) catch {};
        self.dir.close(io_mod.getIo());
        alloc.free(self.path);
        alloc.free(self.name);
        self.* = undefined;
    }
};

fn currentProcessId() u64 {
    return if (comptime builtin.os.tag == .windows)
        std.os.windows.GetCurrentProcessId()
    else
        @intCast(std.c.getpid());
}

fn streamClaude(
    _: ?*anyopaque,
    alloc: Allocator,
    request: stream_provider.ModelRequest,
) anyerror!stream_provider.Result {
    if (comptime !std.process.can_spawn) return error.ProviderUnavailable;
    if (!claude_models.isKnownModel(request.model)) return error.UnsupportedModel;

    const conversation = blk: {
        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try protocol.writeConversation(&out.writer, request.messages);
        break :blk try out.toOwnedSlice();
    };
    defer alloc.free(conversation);
    if (conversation.len == 0) return error.EmptyRequest;

    const system_prompt = try buildSystemPrompt(alloc, request.messages);
    defer if (system_prompt) |value| alloc.free(value);

    var prompt_file: ?SystemPromptFile = if (system_prompt) |value|
        try SystemPromptFile.create(alloc, value)
    else
        null;
    defer if (prompt_file) |*file| file.deinit(alloc);

    // Advertise fx's tools through an fx-hosted MCP server. Claude Code only
    // calls tools it has been told about, and `--mcp-config` names a command to
    // spawn — so fx re-execs itself in bridge mode.
    const advertised = request.tools.advertised_functions;
    var manifest_file: ?SystemPromptFile = if (advertised.len > 0) blk: {
        const manifest = try tool_bridge.manifestAlloc(alloc, advertised);
        defer alloc.free(manifest);
        break :blk try SystemPromptFile.createNamed(alloc, "tools", manifest);
    } else null;
    defer if (manifest_file) |*file| file.deinit(alloc);

    const mcp_config = if (manifest_file) |file|
        try std.fmt.allocPrint(
            alloc,
            // `type` is required: without it Claude Code silently skips the
            // server and reports `mcp_servers: []`.
            "{{\"mcpServers\":{{\"{s}\":{{\"type\":\"stdio\",\"command\":{f},\"args\":[\"{s}\",{f}]}}}}}}",
            .{
                tool_bridge.server_name,
                std.json.fmt(selfExecutable(), .{}),
                tool_bridge.bridge_mode,
                std.json.fmt(file.path, .{}),
            },
        )
    else
        try alloc.dupe(u8, "{\"mcpServers\":{}}");
    defer alloc.free(mcp_config);

    debug_trace.logf("claude", "advertising tools={d}", .{advertised.len});
    debug_trace.logf("claude", "conversation lines={d} bytes={d}", .{
        std.mem.count(u8, conversation, "\n"),
        conversation.len,
    });
    debug_trace.logf("claude", "conversation tail={s}", .{
        conversation[if (conversation.len > 600) conversation.len - 600 else 0..],
    });

    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(alloc);
    try argv.appendSlice(alloc, &.{
        credentials.claudeExecutable(),
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        request.model,
        // Only fx's MCP config applies, so the user's own servers never load
        // into an fx turn.
        "--strict-mcp-config",
        "--mcp-config",
        mcp_config,
        "--disallowedTools",
        disallowed_builtin_tools,
    });
    if (prompt_file) |file| {
        try argv.appendSlice(alloc, &.{ "--system-prompt-file", file.path });
    }

    var child = std.process.spawn(io_mod.getIo(), .{
        .argv = argv.items,
        .stdin = .pipe,
        .stdout = .pipe,
        .stderr = .pipe,
    }) catch |err| switch (err) {
        error.FileNotFound => return error.ClaudeCodeNotInstalled,
        else => {
            debug_trace.logf("claude", "spawn failed err={s}", .{@errorName(err)});
            return error.ProviderUnavailable;
        },
    };
    var reaped = false;
    defer if (!reaped) child.kill(io_mod.getIo());

    // Everything past this point may have reached the model, so the request is
    // no longer safe to replay blindly.
    try request.admission.admit();
    request.delivery.markPossiblySent();
    request.attempt_evidence.provider_admitted = true;

    var input = child.stdin orelse return error.ProviderUnavailable;
    child.stdin = null;
    const write_failed = if (input.writeStreamingAll(io_mod.getIo(), conversation)) |_| false else |err| blk: {
        // A broken pipe means Claude Code rejected the invocation and exited
        // before reading input; its stderr carries the reason.
        debug_trace.logf("claude", "stdin write failed err={s}", .{@errorName(err)});
        break :blk true;
    };
    // Claude Code starts the turn once stdin reaches EOF.
    input.close(io_mod.getIo());

    if (write_failed) {
        const detail = try describeStartupFailure(alloc, &child);
        reaped = true;
        return failure(.provider_error, detail);
    }

    var bridge = EventBridge{ .events = request.events };
    var reader = protocol.Reader.init(alloc, bridge.sink());
    defer reader.deinit();

    const line_buffer = try alloc.alloc(u8, line_buffer_bytes);
    defer alloc.free(line_buffer);

    const stdout = child.stdout orelse return error.ProviderUnavailable;
    var stdout_reader = stdout.readerStreaming(io_mod.getIo(), line_buffer);

    debug_trace.logf("claude", "read loop start", .{});
    while (true) {
        if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;

        // Inclusive: the exclusive variant leaves the delimiter buffered, so it
        // returns an empty slice forever once the first line is consumed.
        // `ingest` trims, so the trailing newline is harmless here.
        const line = stdout_reader.interface.takeDelimiterInclusive('\n') catch |err| switch (err) {
            error.EndOfStream => break,
            error.StreamTooLong => return error.ProviderTransportFailed,
            else => {
                debug_trace.logf("claude", "stdout read failed err={s}", .{@errorName(err)});
                return error.ProviderTransportFailed;
            },
        };
        const stop = reader.ingest(line) catch |err| {
            debug_trace.logf("claude", "stream parse failed err={s}", .{@errorName(err)});
            return error.ProviderMalformedResponse;
        };
        debug_trace.logf("claude", "line bytes={d} stop={s}", .{ line.len, @tagName(stop) });
        if (stop == .finished) break;

        // Capture, don't execute. fx owns tool execution and permissions, so
        // the moment Claude Code asks for a tool the turn is over: fx runs it
        // and replays the result on the next model step.
        if (reader.tool_calls.items.len > 0) {
            debug_trace.logf("claude", "tool call captured; ending turn", .{});
            break;
        }
    }
    debug_trace.logf("claude", "read loop done", .{});

    // A captured tool call leaves Claude Code mid-turn, so it is killed rather
    // than waited on; only a stream that ran to `result` exits on its own.
    const captured_tool_call = reader.tool_calls.items.len > 0 and !reader.done;
    const term: std.process.Child.Term = if (captured_tool_call) blk: {
        child.kill(io_mod.getIo());
        reaped = true;
        break :blk .{ .exited = 0 };
    } else blk: {
        const value = child.wait(io_mod.getIo()) catch |err| {
            debug_trace.logf("claude", "wait failed err={s}", .{@errorName(err)});
            return error.ProviderTransportFailed;
        };
        reaped = true;
        break :blk value;
    };

    // An API-key login must never bill through this route, even if Claude Code
    // would happily serve the turn.
    if (reader.api_key_detected) {
        return failure(.forbidden, try alloc.dupe(
            u8,
            "Claude Code is authenticated with an Anthropic API key. " ++
                "The Claude provider requires a subscription; run `claude auth login`.",
        ));
    }

    if (reader.failure) |reported| {
        const detail = try std.fmt.allocPrint(
            alloc,
            "Claude Code reported {s}{s}{s}",
            .{
                reported.reason,
                if (reported.detail != null) ": " else "",
                reported.detail orelse "",
            },
        );
        return failure(.provider_error, detail);
    }

    if (!reader.done and !captured_tool_call) {
        const detail = try describeAbnormalExit(alloc, term);
        return failure(.provider_error, detail);
    }

    const completion = try reader.toOwnedCompletion();
    return .{ .completed = .{
        .completion = completion,
        .usage = .{ .unavailable = .unbilled },
        .ownership = .owned,
    } };
}

/// Claude Code refused the invocation and exited before reading input. Drain
/// its stderr so the operator sees the actual complaint instead of a generic
/// transport error.
fn describeStartupFailure(alloc: Allocator, child: *std.process.Child) ![]u8 {
    var message: std.ArrayList(u8) = .empty;
    errdefer message.deinit(alloc);
    try message.appendSlice(alloc, "Claude Code exited before reading the request");

    if (child.stderr) |stderr| {
        var buffer: [max_stderr_bytes]u8 = undefined;
        var stderr_reader = stderr.readerStreaming(io_mod.getIo(), &buffer);
        if (stderr_reader.interface.allocRemaining(alloc, .limited(max_stderr_bytes))) |text| {
            defer alloc.free(text);
            const trimmed = std.mem.trim(u8, text, " \t\r\n");
            if (trimmed.len > 0) {
                try message.appendSlice(alloc, ": ");
                try message.appendSlice(alloc, trimmed);
            }
        } else |_| {}
    }

    const term = child.wait(io_mod.getIo()) catch {
        return message.toOwnedSlice(alloc);
    };
    if (term == .exited and term.exited != 0) {
        try message.print(alloc, " (status {d})", .{term.exited});
    }
    return message.toOwnedSlice(alloc);
}

/// Claude Code ended without a terminal `result` line. Report the exit status
/// so a crash or a non-zero exit is distinguishable from a truncated stream.
fn describeAbnormalExit(alloc: Allocator, term: std.process.Child.Term) ![]u8 {
    return switch (term) {
        .exited => |code| if (code == 0)
            try alloc.dupe(u8, "Claude Code exited before completing the turn")
        else
            try std.fmt.allocPrint(alloc, "Claude Code exited with status {d}", .{code}),
        .signal => |sig| try std.fmt.allocPrint(alloc, "Claude Code stopped on signal {d}", .{sig}),
        .stopped => |sig| try std.fmt.allocPrint(alloc, "Claude Code was stopped by signal {d}", .{sig}),
        .unknown => |code| try std.fmt.allocPrint(alloc, "Claude Code ended abnormally ({d})", .{code}),
    };
}

const testing = std.testing;

test "system turns collapse into one prompt and non-system turns are ignored" {
    const prompt = (try buildSystemPrompt(testing.allocator, &.{
        .{ .role = .system, .content = "you are fx" },
        .{ .role = .user, .content = "ignored" },
        .{ .role = .system, .content = "be terse" },
    })).?;
    defer testing.allocator.free(prompt);
    try testing.expectEqualStrings("you are fx\n\nbe terse", prompt);
}

test "a conversation with no system turn produces no prompt override" {
    try testing.expect((try buildSystemPrompt(testing.allocator, &.{
        .{ .role = .user, .content = "hi" },
    })) == null);
    // Empty system content must not create a blank override either.
    try testing.expect((try buildSystemPrompt(testing.allocator, &.{
        .{ .role = .system, .content = "" },
    })) == null);
}

test "claude code built-in tools are stripped so fx keeps tool execution" {
    // fx owns permissions and the transcript; a Claude Code built-in would
    // bypass both.
    for ([_][]const u8{ "Bash", "Read", "Write", "Edit", "WebFetch", "Task" }) |name| {
        try testing.expect(std.mem.indexOf(u8, disallowed_builtin_tools, name) != null);
    }
}

test "abnormal exit descriptions distinguish status from signal" {
    const exited = try describeAbnormalExit(testing.allocator, .{ .exited = 2 });
    defer testing.allocator.free(exited);
    try testing.expectEqualStrings("Claude Code exited with status 2", exited);

    const clean = try describeAbnormalExit(testing.allocator, .{ .exited = 0 });
    defer testing.allocator.free(clean);
    try testing.expectEqualStrings("Claude Code exited before completing the turn", clean);

    const signaled = try describeAbnormalExit(testing.allocator, .{ .signal = @enumFromInt(9) });
    defer testing.allocator.free(signaled);
    try testing.expect(std.mem.startsWith(u8, signaled, "Claude Code stopped on signal"));
}
