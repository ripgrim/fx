const std = @import("std");
const session_permission_state = @import("../permissions/session_permission_state.zig");

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
    var lease = app.acquireMcpRuntime() orelse {
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = "Enter Design mode and connect the design helper first." }, true);
        return;
    };
    defer lease.deinit();
    var result = (lease.runtime.callToolByName(app.alloc, "mcp_fx_design_diff", bound, 65536) catch |err| {
        const failure = try std.fmt.allocPrint(app.alloc, "Comparison unavailable: {s}.", .{@errorName(err)});
        defer app.alloc.free(failure);
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = failure }, true);
        return;
    }) orelse {
        try app.writeDomainNotice(.{ .topic = "diff", .tone = .warning, .body = "Reload the design helper to enable /diff." }, true);
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
