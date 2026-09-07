//! Claude Code `--output-format stream-json` reader.
//!
//! Claude Code emits one JSON object per line. This module turns that stream
//! into the pieces fx's provider seam needs — assistant text, reasoning, tool
//! calls, and final usage — without owning the subprocess or the transport.
//! Keeping it pure makes the wire format testable against captured output.
//!
//! Shapes here were captured from a real `claude -p --output-format stream-json
//! --verbose` run (Claude Code 2.1.257), not inferred:
//!
//!   {"type":"system","subtype":"init","session_id":"...","model":"...", ...}
//!   {"type":"system","subtype":"thinking_tokens","estimated_tokens":33, ...}
//!   {"type":"assistant","message":{"content":[{"type":"text","text":"ok"}], ...}}
//!   {"type":"result","subtype":"success","result":"ok","usage":{...}, ...}
//!
//! Assistant events are incremental: each carries only the blocks produced
//! since the last one, all sharing a `message.id`. Text is therefore appended
//! across events rather than replaced.

const std = @import("std");
const types = @import("../core/shared/types.zig");

const Allocator = std.mem.Allocator;

/// Bounds a single line from a misbehaving or wedged subprocess.
pub const max_line_bytes: usize = 8 * 1024 * 1024;
const max_tool_calls: usize = 128;
const max_tool_name_bytes: usize = 512;

/// Prefix Claude Code gives tools served by an MCP server named `fx`.
pub const fx_tool_prefix = "mcp__fx__";

/// Strips the MCP namespace Claude Code adds so the name matches fx's registry
/// again. Names without the prefix are returned unchanged.
pub fn stripToolPrefix(name: []const u8) []const u8 {
    if (std.mem.startsWith(u8, name, fx_tool_prefix)) {
        return name[fx_tool_prefix.len..];
    }
    return name;
}

/// Serializes an fx conversation into Claude Code's `--input-format
/// stream-json` form: one JSON object per line on stdin.
///
/// Claude Code accepts replayed `assistant` turns, verified against 2.1.257 by
/// injecting an assistant turn and confirming the model answered from it. That
/// lets fx stay stateless — every model step replays the whole conversation
/// into a fresh process rather than resuming a Claude Code session.
///
/// System messages are omitted: they travel as `--system-prompt`, not as
/// stream entries.
pub fn writeConversation(
    writer: *std.Io.Writer,
    messages: []const types.ChatMessage,
) !void {
    for (messages) |message| {
        switch (message.role) {
            .system => {},
            .user => try writeUserText(writer, message.content orelse ""),
            .assistant => try writeAssistant(writer, message),
            .tool => try writeToolResult(writer, message),
        }
    }
}

fn writeUserText(writer: *std.Io.Writer, text: []const u8) !void {
    try writer.writeAll("{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":");
    try std.json.Stringify.value(text, .{}, writer);
    try writer.writeAll("}]}}\n");
}

fn writeAssistant(writer: *std.Io.Writer, message: types.ChatMessage) !void {
    const text = message.content orelse "";
    if (text.len == 0 and message.tool_calls.len == 0) return;

    try writer.writeAll("{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[");
    var wrote_block = false;
    if (text.len > 0) {
        try writer.writeAll("{\"type\":\"text\",\"text\":");
        try std.json.Stringify.value(text, .{}, writer);
        try writer.writeAll("}");
        wrote_block = true;
    }
    for (message.tool_calls) |call| {
        if (wrote_block) try writer.writeAll(",");
        try writer.writeAll("{\"type\":\"tool_use\",\"id\":");
        try std.json.Stringify.value(call.id, .{}, writer);
        try writer.writeAll(",\"name\":");
        // Replayed calls must carry the namespaced name Claude Code knows, or
        // it cannot match them to the tool it offered.
        try writeNamespacedToolName(writer, call.name);
        try writer.writeAll(",\"input\":");
        try writeRawJsonObject(writer, call.arguments_json);
        try writer.writeAll("}");
        wrote_block = true;
    }
    try writer.writeAll("]}}\n");
}

fn writeToolResult(writer: *std.Io.Writer, message: types.ChatMessage) !void {
    // Anthropic carries tool results as user-turn content blocks.
    const call_id = message.tool_call_id orelse return;
    try writer.writeAll("{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":");
    try std.json.Stringify.value(call_id, .{}, writer);
    try writer.writeAll(",\"content\":");
    try std.json.Stringify.value(message.content orelse "", .{}, writer);
    if (message.tool_result_status) |status| {
        if (status == .failure) try writer.writeAll(",\"is_error\":true");
    }
    try writer.writeAll("}]}}\n");
}

fn writeNamespacedToolName(writer: *std.Io.Writer, name: []const u8) !void {
    if (std.mem.startsWith(u8, name, fx_tool_prefix)) {
        try std.json.Stringify.value(name, .{}, writer);
        return;
    }
    var buffer: [max_tool_name_bytes + fx_tool_prefix.len]u8 = undefined;
    if (name.len > max_tool_name_bytes) return error.ClaudeToolNameTooLong;
    const namespaced = try std.fmt.bufPrint(&buffer, fx_tool_prefix ++ "{s}", .{name});
    try std.json.Stringify.value(namespaced, .{}, writer);
}

/// fx stores tool arguments as encoded JSON. Emit them as a JSON value rather
/// than a string, falling back to an empty object when the stored text is not
/// a usable object — a malformed replay would make Claude Code reject the turn.
fn writeRawJsonObject(writer: *std.Io.Writer, raw: []const u8) !void {
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (trimmed.len == 0 or trimmed[0] != '{') {
        try writer.writeAll("{}");
        return;
    }
    try writer.writeAll(trimmed);
}

pub const Stop = enum {
    /// Keep reading; the turn is still producing output.
    keep_reading,
    /// A terminal `result` line was seen.
    finished,
};

/// Owned by the `Reader` that produced it. The JSON tree a line is parsed from
/// is released as soon as the line is consumed, so these must be copies.
pub const Failure = struct {
    /// `result.subtype` when the run ended in an error, else a parse reason.
    reason: []u8,
    /// `result.result` text when Claude Code supplied one.
    detail: ?[]u8 = null,
};

/// Streaming sink so callers can render text as it arrives. Mirrors the shape
/// of `stream_provider.EventSink` without depending on it, keeping this module
/// free of the agent runtime.
pub const Sink = struct {
    context: ?*anyopaque = null,
    on_text: ?*const fn (context: ?*anyopaque, text: []const u8) void = null,
    on_reasoning: ?*const fn (context: ?*anyopaque, text: []const u8) void = null,
    on_tool: ?*const fn (context: ?*anyopaque, id: []const u8, name: []const u8) void = null,

    fn text(self: Sink, value: []const u8) void {
        if (self.on_text) |cb| cb(self.context, value);
    }
    fn reasoning(self: Sink, value: []const u8) void {
        if (self.on_reasoning) |cb| cb(self.context, value);
    }
    fn tool(self: Sink, id: []const u8, name: []const u8) void {
        if (self.on_tool) |cb| cb(self.context, id, name);
    }
};

/// Accumulates one Claude Code run into an fx completion.
pub const Reader = struct {
    alloc: Allocator,
    sink: Sink = .{},

    text: std.ArrayList(u8) = .empty,
    tool_calls: std.ArrayList(types.ToolCall) = .empty,
    session_id: ?[]u8 = null,
    model: ?[]u8 = null,
    usage: types.Usage = .{},
    failure: ?Failure = null,
    /// Set once a terminal `result` line has been consumed.
    done: bool = false,
    /// True when Claude Code reported it was running on an API key rather than
    /// a subscription. The Claude route refuses to bill an API account.
    api_key_detected: bool = false,
    /// Claude Code called one of its own tools instead of an fx tool. The
    /// transport uses this to tell "still working" apart from "produced
    /// something fx can act on".
    foreign_tool_seen: bool = false,

    pub fn init(alloc: Allocator, sink: Sink) Reader {
        return .{ .alloc = alloc, .sink = sink };
    }

    pub fn deinit(self: *Reader) void {
        self.text.deinit(self.alloc);
        // Free each call's fields only. `freeToolCallSlice` would also free the
        // slice, but `items` is a view into the list's buffer, not its
        // allocation — `deinit` owns that.
        for (self.tool_calls.items) |call| types.freeToolCall(self.alloc, call);
        self.tool_calls.deinit(self.alloc);
        if (self.session_id) |value| self.alloc.free(value);
        if (self.model) |value| self.alloc.free(value);
        if (self.failure) |value| {
            self.alloc.free(value.reason);
            if (value.detail) |detail| self.alloc.free(detail);
        }
        self.* = undefined;
    }

    /// Consumes one newline-delimited JSON object. Blank lines are ignored so
    /// callers can feed raw stream splits. Unrecognized line types are skipped
    /// rather than failing: Claude Code adds event kinds over time, and an
    /// unknown one is not a reason to abandon a turn already in flight.
    pub fn ingest(self: *Reader, line: []const u8) !Stop {
        const trimmed = std.mem.trim(u8, line, " \t\r\n");
        if (trimmed.len == 0) return .keep_reading;
        if (trimmed.len > max_line_bytes) return error.ClaudeStreamLineTooLong;

        var parsed = std.json.parseFromSlice(std.json.Value, self.alloc, trimmed, .{}) catch
            return error.InvalidClaudeStreamJson;
        defer parsed.deinit();
        if (parsed.value != .object) return error.InvalidClaudeStreamJson;
        const object = parsed.value.object;

        const kind = stringField(object, "type") orelse return error.InvalidClaudeStreamJson;
        if (std.mem.eql(u8, kind, "system")) {
            try self.ingestSystem(object);
            return .keep_reading;
        }
        if (std.mem.eql(u8, kind, "assistant")) {
            try self.ingestAssistant(object);
            return .keep_reading;
        }
        if (std.mem.eql(u8, kind, "result")) {
            try self.ingestResult(object);
            self.done = true;
            return .finished;
        }
        return .keep_reading;
    }

    fn ingestSystem(self: *Reader, object: std.json.ObjectMap) !void {
        const subtype = stringField(object, "subtype") orelse return;
        if (!std.mem.eql(u8, subtype, "init")) return;

        if (self.session_id == null) {
            if (stringField(object, "session_id")) |value| {
                self.session_id = try self.alloc.dupe(u8, value);
            }
        }
        if (self.model == null) {
            if (stringField(object, "model")) |value| {
                self.model = try self.alloc.dupe(u8, value);
            }
        }
        // `apiKeySource` is "none" on a subscription login and names the source
        // ("ANTHROPIC_API_KEY", "apiKeyHelper", …) otherwise.
        if (stringField(object, "apiKeySource")) |source| {
            if (!std.mem.eql(u8, source, "none")) self.api_key_detected = true;
        }
    }

    fn ingestAssistant(self: *Reader, object: std.json.ObjectMap) !void {
        const message = object.get("message") orelse return;
        if (message != .object) return;
        const content = message.object.get("content") orelse return;
        if (content != .array) return;

        for (content.array.items) |block| {
            if (block != .object) continue;
            const block_type = stringField(block.object, "type") orelse continue;

            if (std.mem.eql(u8, block_type, "text")) {
                const value = stringField(block.object, "text") orelse continue;
                try self.text.appendSlice(self.alloc, value);
                self.sink.text(value);
                continue;
            }
            if (std.mem.eql(u8, block_type, "thinking")) {
                const value = stringField(block.object, "thinking") orelse continue;
                // Reasoning is surfaced for rendering but never folded into the
                // completion text: fx replays content, not chain of thought.
                self.sink.reasoning(value);
                continue;
            }
            if (std.mem.eql(u8, block_type, "tool_use")) {
                try self.appendToolCall(block.object);
                continue;
            }
        }
    }

    fn appendToolCall(self: *Reader, block: std.json.ObjectMap) !void {
        if (self.tool_calls.items.len >= max_tool_calls) return error.ClaudeStreamTooManyToolCalls;

        const raw_id = stringField(block, "id") orelse return error.InvalidClaudeStreamJson;
        const raw_name = stringField(block, "name") orelse return error.InvalidClaudeStreamJson;

        // Only fx's own tools are ours to execute. A Claude Code built-in that
        // slipped past the disallow list would otherwise be handed to fx's
        // registry, which has never heard of it.
        if (!std.mem.startsWith(u8, raw_name, fx_tool_prefix)) {
            self.foreign_tool_seen = true;
            return;
        }
        if (raw_id.len == 0 or raw_id.len > max_tool_name_bytes) return error.InvalidClaudeStreamJson;
        if (raw_name.len == 0 or raw_name.len > max_tool_name_bytes) return error.InvalidClaudeStreamJson;

        const id = try self.alloc.dupe(u8, raw_id);
        errdefer self.alloc.free(id);
        const name = try self.alloc.dupe(u8, stripToolPrefix(raw_name));
        errdefer self.alloc.free(name);

        // `input` is a JSON object; fx carries tool arguments as encoded JSON.
        var arguments: std.Io.Writer.Allocating = .init(self.alloc);
        errdefer arguments.deinit();
        if (block.get("input")) |input| {
            try std.json.Stringify.value(input, .{}, &arguments.writer);
        } else {
            try arguments.writer.writeAll("{}");
        }

        try self.tool_calls.append(self.alloc, .{
            .id = id,
            .name = name,
            .arguments_json = try arguments.toOwnedSlice(),
        });
        self.sink.tool(id, name);
    }

    fn ingestResult(self: *Reader, object: std.json.ObjectMap) !void {
        if (object.get("usage")) |usage| {
            if (usage == .object) self.usage = readUsage(usage.object);
        }

        const errored = boolField(object, "is_error") orelse false;
        const subtype = stringField(object, "subtype") orelse "";
        if (errored or (subtype.len > 0 and !std.mem.eql(u8, subtype, "success"))) {
            const reason = try self.alloc.dupe(u8, if (subtype.len > 0) subtype else "error");
            errdefer self.alloc.free(reason);
            const detail = if (stringField(object, "result")) |value|
                try self.alloc.dupe(u8, value)
            else
                null;
            self.failure = .{ .reason = reason, .detail = detail };
            return;
        }

        // A successful run reports the final assistant text in `result`. Prefer
        // it only when no assistant text arrived, so partial streams still
        // produce what was actually received.
        if (self.text.items.len == 0) {
            if (stringField(object, "result")) |value| {
                try self.text.appendSlice(self.alloc, value);
            }
        }
    }

    /// True when the run produced neither text nor a tool call.
    pub fn isEmpty(self: *const Reader) bool {
        return self.text.items.len == 0 and self.tool_calls.items.len == 0;
    }

    /// Transfers the accumulated turn out of the reader. The reader keeps no
    /// claim on the returned memory; the caller frees it.
    pub fn toOwnedCompletion(self: *Reader) !types.ModelCompletion {
        const content: ?[]const u8 = if (self.text.items.len == 0)
            null
        else
            try self.text.toOwnedSlice(self.alloc);
        errdefer if (content) |value| self.alloc.free(@constCast(value));

        const tool_calls = try self.tool_calls.toOwnedSlice(self.alloc);
        return .{
            .content = content,
            .tool_calls = tool_calls,
            .usage = self.usage,
            .finish_reason = if (tool_calls.len > 0) .tool_calls else .stop,
        };
    }
};

fn readUsage(object: std.json.ObjectMap) types.Usage {
    return .{
        .input_tokens = unsignedField(object, "input_tokens"),
        .output_tokens = unsignedField(object, "output_tokens"),
        .cache_read_tokens = unsignedField(object, "cache_read_input_tokens"),
        .cache_write_tokens = unsignedField(object, "cache_creation_input_tokens"),
    };
}

fn stringField(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    if (value != .string) return null;
    return value.string;
}

fn boolField(object: std.json.ObjectMap, key: []const u8) ?bool {
    const value = object.get(key) orelse return null;
    if (value != .bool) return null;
    return value.bool;
}

fn unsignedField(object: std.json.ObjectMap, key: []const u8) ?u64 {
    const value = object.get(key) orelse return null;
    if (value != .integer) return null;
    if (value.integer < 0) return null;
    return @intCast(value.integer);
}

const testing = std.testing;

fn renderConversation(alloc: Allocator, messages: []const types.ChatMessage) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try writeConversation(&out.writer, messages);
    return out.toOwnedSlice();
}

test "a user turn serializes as a single stream-json line" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{ .role = .user, .content = "hello" },
    });
    defer testing.allocator.free(rendered);

    try testing.expectEqualStrings(
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n",
        rendered,
    );
}

test "system turns are omitted because they travel as --system-prompt" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{ .role = .system, .content = "you are fx" },
        .{ .role = .user, .content = "hi" },
    });
    defer testing.allocator.free(rendered);

    try testing.expect(std.mem.indexOf(u8, rendered, "you are fx") == null);
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, rendered, "\n"));
}

test "assistant tool calls replay with the namespaced name and raw arguments" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{
            .role = .assistant,
            .content = "Looking.",
            .tool_calls = &.{.{
                .id = "toolu_1",
                .name = "read",
                .arguments_json = "{\"path\":\"/a\"}",
            }},
        },
    });
    defer testing.allocator.free(rendered);

    // Namespaced so Claude Code matches it to the tool fx offered over MCP.
    try testing.expect(std.mem.indexOf(u8, rendered, "\"name\":\"mcp__fx__read\"") != null);
    // Arguments are a JSON value, not a quoted string.
    try testing.expect(std.mem.indexOf(u8, rendered, "\"input\":{\"path\":\"/a\"}") != null);
    try testing.expect(std.mem.indexOf(u8, rendered, "\"type\":\"text\",\"text\":\"Looking.\"") != null);
}

test "an already-namespaced tool name is not double prefixed" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{
            .role = .assistant,
            .tool_calls = &.{.{ .id = "t", .name = "mcp__fx__read", .arguments_json = "{}" }},
        },
    });
    defer testing.allocator.free(rendered);
    try testing.expect(std.mem.indexOf(u8, rendered, "mcp__fx__mcp__fx__") == null);
    try testing.expect(std.mem.indexOf(u8, rendered, "\"name\":\"mcp__fx__read\"") != null);
}

test "malformed stored arguments degrade to an empty object" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{
            .role = .assistant,
            .tool_calls = &.{.{ .id = "t", .name = "read", .arguments_json = "not json" }},
        },
    });
    defer testing.allocator.free(rendered);
    try testing.expect(std.mem.indexOf(u8, rendered, "\"input\":{}") != null);
}

test "tool results serialize as user-turn tool_result blocks" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{ .role = .tool, .tool_call_id = "toolu_1", .content = "file contents" },
    });
    defer testing.allocator.free(rendered);

    try testing.expect(std.mem.indexOf(u8, rendered, "\"role\":\"user\"") != null);
    try testing.expect(std.mem.indexOf(u8, rendered, "\"type\":\"tool_result\"") != null);
    try testing.expect(std.mem.indexOf(u8, rendered, "\"tool_use_id\":\"toolu_1\"") != null);
    try testing.expect(std.mem.indexOf(u8, rendered, "\"content\":\"file contents\"") != null);
    try testing.expect(std.mem.indexOf(u8, rendered, "is_error") == null);
}

test "a failed tool result is flagged so the model can recover" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{
            .role = .tool,
            .tool_call_id = "toolu_1",
            .content = "permission denied",
            .tool_result_status = .failure,
        },
    });
    defer testing.allocator.free(rendered);
    try testing.expect(std.mem.indexOf(u8, rendered, "\"is_error\":true") != null);
}

test "a tool result with no call id is dropped rather than emitted unmatched" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{ .role = .tool, .content = "orphan" },
    });
    defer testing.allocator.free(rendered);
    try testing.expectEqual(@as(usize, 0), rendered.len);
}

test "an empty assistant turn emits nothing" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{ .role = .assistant, .content = "" },
    });
    defer testing.allocator.free(rendered);
    try testing.expectEqual(@as(usize, 0), rendered.len);
}

test "control characters and quotes survive serialization" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{ .role = .user, .content = "say \"hi\"\n\tand stop" },
    });
    defer testing.allocator.free(rendered);

    // Exactly one line: the payload's newline must be escaped, not literal.
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, rendered, "\n"));

    var parsed = try std.json.parseFromSlice(
        std.json.Value,
        testing.allocator,
        std.mem.trimEnd(u8, rendered, "\n"),
        .{},
    );
    defer parsed.deinit();
    const content = parsed.value.object.get("message").?.object.get("content").?;
    try testing.expectEqualStrings("say \"hi\"\n\tand stop", content.array.items[0].object.get("text").?.string);
}

test "every serialized line is valid standalone JSON" {
    const rendered = try renderConversation(testing.allocator, &.{
        .{ .role = .user, .content = "one" },
        .{
            .role = .assistant,
            .content = "two",
            .tool_calls = &.{.{ .id = "t", .name = "read", .arguments_json = "{\"a\":1}" }},
        },
        .{ .role = .tool, .tool_call_id = "t", .content = "three" },
    });
    defer testing.allocator.free(rendered);

    var lines = std.mem.tokenizeScalar(u8, rendered, '\n');
    var count: usize = 0;
    while (lines.next()) |line| {
        var parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, line, .{});
        defer parsed.deinit();
        try testing.expect(parsed.value == .object);
        count += 1;
    }
    try testing.expectEqual(@as(usize, 3), count);
}

test "tool prefix stripping restores the fx registry name" {
    try testing.expectEqualStrings("read", stripToolPrefix("mcp__fx__read"));
    try testing.expectEqualStrings("run_command", stripToolPrefix("mcp__fx__run_command"));
    try testing.expectEqualStrings("Bash", stripToolPrefix("Bash"));
    try testing.expectEqualStrings("mcp__other__x", stripToolPrefix("mcp__other__x"));
}

test "captured success stream yields assistant text and exact usage" {
    // Trimmed from a real Claude Code 2.1.257 run.
    const init_line =
        \\{"type":"system","subtype":"init","session_id":"fb8f849b","model":"claude-haiku-4-5","apiKeySource":"none"}
    ;
    const thinking_line =
        \\{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"deciding"}]}}
    ;
    const text_line =
        \\{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"ok"}]}}
    ;
    const result_line =
        \\{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":10,"output_tokens":41,"cache_read_input_tokens":7039,"cache_creation_input_tokens":10967}}
    ;

    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    try testing.expectEqual(Stop.keep_reading, try reader.ingest(init_line));
    try testing.expectEqual(Stop.keep_reading, try reader.ingest(thinking_line));
    try testing.expectEqual(Stop.keep_reading, try reader.ingest(text_line));
    try testing.expectEqual(Stop.finished, try reader.ingest(result_line));

    try testing.expect(reader.done);
    try testing.expect(reader.failure == null);
    try testing.expect(!reader.api_key_detected);
    try testing.expectEqualStrings("fb8f849b", reader.session_id.?);
    try testing.expectEqualStrings("claude-haiku-4-5", reader.model.?);

    const completion = try reader.toOwnedCompletion();
    defer {
        if (completion.content) |value| testing.allocator.free(@constCast(value));
        types.freeToolCallSlice(testing.allocator, @constCast(completion.tool_calls));
    }
    // Reasoning is never folded into replayable content.
    try testing.expectEqualStrings("ok", completion.content.?);
    try testing.expectEqual(@as(u64, 10), completion.usage.input_tokens.?);
    try testing.expectEqual(@as(u64, 41), completion.usage.output_tokens.?);
    try testing.expectEqual(@as(u64, 7039), completion.usage.cache_read_tokens.?);
    try testing.expectEqual(@as(u64, 10967), completion.usage.cache_write_tokens.?);
}

test "assistant text accumulates across incremental events" {
    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    _ = try reader.ingest(
        \\{"type":"assistant","message":{"content":[{"type":"text","text":"Hello, "}]}}
    );
    _ = try reader.ingest(
        \\{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}
    );

    const completion = try reader.toOwnedCompletion();
    defer {
        if (completion.content) |value| testing.allocator.free(@constCast(value));
        types.freeToolCallSlice(testing.allocator, @constCast(completion.tool_calls));
    }
    try testing.expectEqualStrings("Hello, world", completion.content.?);
}

test "claude code built-in tool calls are not mistaken for fx tools" {
    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    _ = try reader.ingest(
        \\{"type":"assistant","message":{"content":[
        \\{"type":"tool_use","id":"t1","name":"ToolSearch","input":{"q":"read"}},
        \\{"type":"tool_use","id":"t2","name":"mcp__fx__read","input":{"path":"/a"}}]}}
    );

    // Only fx's own tool is executable by fx.
    try testing.expectEqual(@as(usize, 1), reader.tool_calls.items.len);
    try testing.expectEqualStrings("read", reader.tool_calls.items[0].name);
    try testing.expect(reader.foreign_tool_seen);
}

test "mcp tool calls are captured with fx names and encoded arguments" {
    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    _ = try reader.ingest(
        \\{"type":"assistant","message":{"content":[
        \\{"type":"text","text":"Reading it."},
        \\{"type":"tool_use","id":"toolu_9","name":"mcp__fx__read","input":{"path":"/tmp/a.txt"}}]}}
    );

    try testing.expectEqual(@as(usize, 1), reader.tool_calls.items.len);

    const completion = try reader.toOwnedCompletion();
    defer {
        if (completion.content) |value| testing.allocator.free(@constCast(value));
        types.freeToolCallSlice(testing.allocator, @constCast(completion.tool_calls));
    }
    try testing.expectEqualStrings("toolu_9", completion.tool_calls[0].id);
    try testing.expectEqualStrings("read", completion.tool_calls[0].name);
    try testing.expectEqualStrings("{\"path\":\"/tmp/a.txt\"}", completion.tool_calls[0].arguments_json);
    try testing.expectEqual(types.ProviderFinishReason.tool_calls, completion.finish_reason.?);
}

test "a tool_use with no input still carries an empty object" {
    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    _ = try reader.ingest(
        \\{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__fx__status"}]}}
    );

    const completion = try reader.toOwnedCompletion();
    defer {
        if (completion.content) |value| testing.allocator.free(@constCast(value));
        types.freeToolCallSlice(testing.allocator, @constCast(completion.tool_calls));
    }
    try testing.expectEqualStrings("{}", completion.tool_calls[0].arguments_json);
}

test "an api key login is detected from the init line" {
    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    _ = try reader.ingest(
        \\{"type":"system","subtype":"init","apiKeySource":"ANTHROPIC_API_KEY"}
    );
    try testing.expect(reader.api_key_detected);
}

test "an errored result records the failure and leaves text untouched" {
    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    _ = try reader.ingest(
        \\{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}
    );
    try testing.expect(reader.done);
    try testing.expectEqualStrings("error_during_execution", reader.failure.?.reason);
    try testing.expectEqualStrings("boom", reader.failure.?.detail.?);
}

test "result text is used only when no assistant text arrived" {
    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    _ = try reader.ingest(
        \\{"type":"result","subtype":"success","result":"recovered"}
    );
    const completion = try reader.toOwnedCompletion();
    defer {
        if (completion.content) |value| testing.allocator.free(@constCast(value));
        types.freeToolCallSlice(testing.allocator, @constCast(completion.tool_calls));
    }
    try testing.expectEqualStrings("recovered", completion.content.?);
}

test "unknown and blank lines never abort a turn in flight" {
    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    try testing.expectEqual(Stop.keep_reading, try reader.ingest(""));
    try testing.expectEqual(Stop.keep_reading, try reader.ingest("   \r\n"));
    try testing.expectEqual(Stop.keep_reading, try reader.ingest(
        \\{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}
    ));
    try testing.expectEqual(Stop.keep_reading, try reader.ingest(
        \\{"type":"system","subtype":"thinking_tokens","estimated_tokens":33}
    ));
    try testing.expectEqual(Stop.keep_reading, try reader.ingest(
        \\{"type":"some_future_event","payload":{"a":1}}
    ));
    try testing.expect(reader.isEmpty());
    try testing.expect(!reader.done);
}

test "malformed lines are rejected rather than silently dropped" {
    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    try testing.expectError(error.InvalidClaudeStreamJson, reader.ingest("not json"));
    try testing.expectError(error.InvalidClaudeStreamJson, reader.ingest("[]"));
    try testing.expectError(error.InvalidClaudeStreamJson, reader.ingest("{\"no\":\"type\"}"));
}

test "a tool_use missing its identity is rejected" {
    var reader = Reader.init(testing.allocator, .{});
    defer reader.deinit();

    try testing.expectError(error.InvalidClaudeStreamJson, reader.ingest(
        \\{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__fx__read"}]}}
    ));
}

test "streaming sink observes text reasoning and tool starts in order" {
    const Capture = struct {
        text: std.ArrayList(u8) = .empty,
        reasoning: std.ArrayList(u8) = .empty,
        tools: std.ArrayList(u8) = .empty,
        alloc: Allocator,

        fn onText(context: ?*anyopaque, value: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(context.?));
            self.text.appendSlice(self.alloc, value) catch {};
        }
        fn onReasoning(context: ?*anyopaque, value: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(context.?));
            self.reasoning.appendSlice(self.alloc, value) catch {};
        }
        fn onTool(context: ?*anyopaque, _: []const u8, name: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(context.?));
            self.tools.appendSlice(self.alloc, name) catch {};
        }
    };

    var capture = Capture{ .alloc = testing.allocator };
    defer capture.text.deinit(testing.allocator);
    defer capture.reasoning.deinit(testing.allocator);
    defer capture.tools.deinit(testing.allocator);

    var reader = Reader.init(testing.allocator, .{
        .context = &capture,
        .on_text = Capture.onText,
        .on_reasoning = Capture.onReasoning,
        .on_tool = Capture.onTool,
    });
    defer reader.deinit();

    _ = try reader.ingest(
        \\{"type":"assistant","message":{"content":[
        \\{"type":"thinking","thinking":"weighing"},
        \\{"type":"text","text":"done"},
        \\{"type":"tool_use","id":"t1","name":"mcp__fx__edit","input":{}}]}}
    );

    try testing.expectEqualStrings("done", capture.text.items);
    try testing.expectEqualStrings("weighing", capture.reasoning.items);
    try testing.expectEqualStrings("edit", capture.tools.items);
}
