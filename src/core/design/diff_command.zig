const std = @import("std");
const session_permission_state = @import("../permissions/session_permission_state.zig");
const io_mod = @import("../shared/io.zig");

fn call(app: anytype, bound: []const u8) !?@import("../tooling/tool_mcp_runtime.zig").CallResult {
    var lease = app.acquireMcpRuntime() orelse return null;
    defer lease.deinit();
    return lease.runtime.callToolByName(app.alloc, "mcp_fx_design_diff", bound, 65536);
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
        try io_mod.getIo().sleep(.fromMilliseconds(50), .awake);
        if (try call(app, bound)) |result| return result;
    }
    return null;
}

/// Direct user command. No agent turn, source edits, or Paper mutations.
pub fn run(app: anytype, rest: []const u8, session_id: ?[]const u8) !void {
    const design = @import("../design/managed_helper.zig");
    const id = session_id orelse {
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = "Open a session with an imported artboard first." }, true);
        return;
    };
    const args = try std.json.Stringify.valueAlloc(app.alloc, .{ .target = rest }, .{});
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
    var result = (callWithRecovery(app, bound) catch |err| {
        const failure = try std.fmt.allocPrint(app.alloc, "Comparison unavailable: {s}.", .{@errorName(err)});
        defer app.alloc.free(failure);
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = failure }, true);
        return;
    }) orelse {
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = "Design helper unavailable. Check /mcp." }, true);
        return;
    };
    defer result.deinit(app.alloc);
    const json = design.resultJson(app.alloc, result.model_output) catch {
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = "Comparison failed. Check the Paper connection and capture state." }, true);
        return;
    };
    defer app.alloc.free(json);
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
