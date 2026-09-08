const std = @import("std");
const session_permission_state = @import("../permissions/session_permission_state.zig");
const io_mod = @import("../shared/io.zig");
const mcp_state = @import("../app/app_mcp_runtime.zig");
const design = @import("managed_helper.zig");

pub const State = struct {
    job: ?*Job = null,

    pub fn deinit(self: *State) void {
        if (self.job) |job| job.destroy();
        self.* = .{};
    }
};

const Job = struct {
    alloc: std.mem.Allocator = std.heap.c_allocator,
    mcp: *mcp_state.State,
    workspace_root: []const u8,
    registry: @import("../tooling/tool_dispatch.zig").Registry,
    bound: []const u8,
    session_id: []const u8,
    thread: ?std.Thread = null,
    cancelled: std.atomic.Value(bool) = .init(false),
    finished: std.atomic.Value(bool) = .init(false),
    json: ?[]u8 = null,
    failure: ?anyerror = null,

    pub fn acquireMcpRuntime(self: *Job) ?mcp_state.Lease {
        return self.mcp.acquire();
    }

    pub fn beginMcpReload(self: *Job) !void {
        const builtin_mcp = @import("../../builtins/mcp.zig");
        try self.mcp.beginReload(self.alloc, self.workspace_root, .{ .form = true, .url = true }, builtin_mcp.loadRuntime, builtin_mcp.previewNativeWorkspaceAuthority, self.registry, @intCast(@max(io_mod.milliTimestamp(), 0)));
    }

    pub fn ensureDesignModeMcp(self: *Job) !@import("../modes/design_mode.zig").McpSetupOutcome {
        return @import("../app/app_mcp_menu_runtime.zig").Runtime(Job).ensureDesignModeBackend(self);
    }

    fn work(self: *Job) void {
        defer self.finished.store(true, .release);
        self.execute() catch |err| {
            self.failure = err;
        };
    }

    fn execute(self: *Job) !void {
        var result = (try callWithRecovery(self, self.bound)) orelse return error.DesignHelperUnavailable;
        defer result.deinit(self.alloc);
        self.json = try design.resultJson(self.alloc, result.model_output);
    }

    fn destroy(self: *Job) void {
        self.cancelled.store(true, .release);
        if (self.thread) |thread| thread.join();
        if (self.json) |json| self.alloc.free(json);
        self.alloc.free(self.bound);
        self.alloc.free(self.workspace_root);
        self.alloc.free(self.session_id);
        self.alloc.destroy(self);
    }
};

fn call(app: anytype, bound: []const u8) !?@import("../tooling/tool_mcp_runtime.zig").CallResult {
    var lease = app.acquireMcpRuntime() orelse return null;
    defer lease.deinit();
    return lease.runtime.callToolByNameWithOptions(app.alloc, "mcp_fx_design_diff", bound, 65536, .{ .cancel_flag = &app.cancelled });
}

// An existing process can still advertise the previous bundle's catalog.
// Refresh once, release the old runtime lease, and wait for publication.
fn callWithRecovery(app: anytype, bound: []const u8) !?@import("../tooling/tool_mcp_runtime.zig").CallResult {
    if (try call(app, bound)) |result| return result;
    if (comptime !@hasDecl(@TypeOf(app.*), "ensureDesignModeMcp")) return null;
    const outcome = try app.ensureDesignModeMcp();
    if (outcome == .installed_reload_failed) return error.McpRuntimeUnavailable;
    const start = std.Io.Clock.awake.now(io_mod.getIo());
    while (start.durationTo(std.Io.Clock.awake.now(io_mod.getIo())).toMilliseconds() < 15000) {
        if (app.cancelled.load(.acquire)) return error.Cancelled;
        try io_mod.getIo().sleep(.fromMilliseconds(50), .awake);
        if (try call(app, bound)) |result| return result;
    }
    return null;
}

/// Direct user command. No agent turn, source edits, or Paper mutations.
pub fn run(app: anytype, rest: []const u8, session_id: ?[]const u8) !void {
    if (app.design_diff.job != null) return;
    const id = session_id orelse {
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = "Open a session with an imported artboard first." }, true);
        return;
    };
    const args = try std.json.Stringify.valueAlloc(app.alloc, .{ .target = rest, .workspace = app.workspace_root }, .{});
    defer app.alloc.free(args);
    const bound = try design.bindArguments(app.alloc, args, id);
    defer app.alloc.free(bound);
    var arena = std.heap.ArenaAllocator.init(app.alloc);
    defer arena.deinit();
    const prepared = app.preparePermissionStateAction(arena.allocator(), .{ .id = "diff-command", .name = "mcp_fx_design_diff", .arguments_json = bound }) catch |err| switch (err) {
        error.UnsupportedTool => null, // MCP tools do not have durable action keys.
        else => return err,
    };
    var saved = try app.session.snapshotPermissionState(app.alloc);
    defer saved.deinit(app.alloc);
    if (prepared != null and session_permission_state.decide(saved, prepared.?.key) == .deny) {
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = "Diff is denied for this session." }, true);
        return;
    }
    const decision = try app.permission_engine.configuredRuleDecision(app.alloc, app.workspace_root, "mcp_fx_design_diff", bound, .none);
    if (decision == .deny or decision == .ask) {
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = "Diff is restricted by your MCP permission rule." }, true);
        return;
    }
    const alloc = std.heap.c_allocator;
    const job = try alloc.create(Job);
    errdefer alloc.destroy(job);
    const owned_bound = try alloc.dupe(u8, bound);
    errdefer alloc.free(owned_bound);
    const workspace = try alloc.dupe(u8, app.workspace_root);
    errdefer alloc.free(workspace);
    const owned_id = try alloc.dupe(u8, id);
    errdefer alloc.free(owned_id);
    job.* = .{ .mcp = &app.mcp, .workspace_root = workspace, .registry = app.toolRegistry(), .bound = owned_bound, .session_id = owned_id };
    job.thread = try std.Thread.spawn(.{}, Job.work, .{job});
    app.design_diff.job = job;
    app.shell.render_requests.request(.footer);
}

pub fn collect(app: anytype, session_id: ?[]const u8) !void {
    const job = app.design_diff.job orelse return;
    app.shell.render_requests.request(.footer);
    if (!job.finished.load(.acquire)) return;
    app.design_diff.job = null;
    defer job.destroy();
    // Never publish a result into a different conversation or workspace.
    if (!std.mem.eql(u8, session_id orelse "", job.session_id) or !std.mem.eql(u8, app.workspace_root, job.workspace_root)) return;
    if (job.failure != null) {
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = "Comparison unavailable. Check /mcp." }, true);
        return;
    }
    const json = job.json orelse return;
    const Snapshot = struct { status: []const u8 = "blocked", url: ?[]const u8 = null, message: []const u8 = "Comparison unavailable." };
    var parsed = try std.json.parseFromSlice(Snapshot, app.alloc, json, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const snapshot = parsed.value;
    if (std.mem.eql(u8, snapshot.status, "ready")) {
        const url = snapshot.url orelse return error.InvalidDiffResult;
        const body = try design.diffNotice(app.alloc, url);
        defer app.alloc.free(body);
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .neutral, .body = body }, true);
    } else try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = snapshot.message }, true);
}
