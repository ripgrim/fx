//! MCP stdio server that advertises fx's tools to Claude Code.
//!
//! Claude Code only calls tools it was told about, and `--mcp-config` names a
//! *command* to spawn rather than an in-process handle. fx therefore re-execs
//! itself in bridge mode: Claude Code spawns `fx <bridge_mode> <manifest>`, and
//! this server answers the MCP handshake from a manifest the parent wrote.
//!
//! The bridge advertises tools but never runs them. fx's transport watches the
//! stream for a `tool_use` and ends the Claude Code process there, so execution
//! happens back in fx's own loop under fx's permissions. `tools/call` therefore
//! only has to stay well-behaved long enough to be killed.

const std = @import("std");
const io_mod = @import("../core/shared/io.zig");
const model_tool_schema = @import("../core/tooling/model_tool_schema.zig");

const Allocator = std.mem.Allocator;

/// Hidden argv[1] marker. Underscored so it cannot collide with a real command.
pub const bridge_mode = "__claude-tool-bridge";

/// MCP server name; Claude Code namespaces tools as `mcp__<name>__<tool>`.
pub const server_name = "fx";

const protocol_version = "2025-06-18";
const max_request_bytes: usize = 4 * 1024 * 1024;
const max_manifest_bytes: usize = 8 * 1024 * 1024;

pub fn isBridgeModeRaw(raw_args: []const [*:0]const u8) bool {
    return raw_args.len == 3 and
        std.mem.eql(u8, std.mem.sliceTo(raw_args[1], 0), bridge_mode);
}

/// Serializes fx's advertised tools into the `tools` array Claude Code expects
/// from `tools/list`. The parent writes this to a file the bridge reads back,
/// keeping schemas off the command line where they would blow the arg limit.
pub fn writeManifest(
    alloc: Allocator,
    writer: *std.Io.Writer,
    functions: []const model_tool_schema.FunctionSchema,
) !void {
    try writer.writeAll("[");
    for (functions, 0..) |function, index| {
        if (index > 0) try writer.writeByte(',');
        try writer.writeAll("{\"name\":");
        try std.json.Stringify.value(function.name, .{}, writer);
        try writer.writeAll(",\"description\":");
        try std.json.Stringify.value(function.description, .{}, writer);
        try writer.writeAll(",\"inputSchema\":");
        try model_tool_schema.writeObjectSchema(alloc, writer, function.input_schema);
        try writer.writeAll("}");
    }
    try writer.writeAll("]");
}

pub fn manifestAlloc(
    alloc: Allocator,
    functions: []const model_tool_schema.FunctionSchema,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try writeManifest(alloc, &out.writer, functions);
    return out.toOwnedSlice();
}

/// Serves MCP over stdio until stdin closes. Claude Code kills the bridge when
/// the session ends, and fx's transport kills the session on the first tool
/// call, so a clean EOF exit is the normal path.
pub fn run(alloc: Allocator, raw_args: []const [*:0]const u8) !void {
    if (!isBridgeModeRaw(raw_args)) return error.InvalidClaudeToolBridge;
    const manifest_path = std.mem.sliceTo(raw_args[2], 0);

    const manifest = readManifest(alloc, manifest_path) catch
        try alloc.dupe(u8, "[]");
    defer alloc.free(manifest);

    // Heap, not stack: an MCP request can be megabytes and a stack array that
    // size overflows before the first read.
    const in_buffer = try alloc.alloc(u8, max_request_bytes);
    defer alloc.free(in_buffer);
    const out_buffer = try alloc.alloc(u8, 64 * 1024);
    defer alloc.free(out_buffer);

    var stdin = std.Io.File.stdin().readerStreaming(io_mod.getIo(), in_buffer);
    var stdout = std.Io.File.stdout().writerStreaming(io_mod.getIo(), out_buffer);

    while (true) {
        const line = stdin.interface.takeDelimiterInclusive('\n') catch break;
        const trimmed = std.mem.trim(u8, line, " \t\r\n");
        if (trimmed.len == 0) continue;

        const response = buildResponse(alloc, trimmed, manifest) catch continue;
        const payload = response orelse continue; // notification: no reply
        defer alloc.free(payload);

        stdout.interface.writeAll(payload) catch break;
        stdout.interface.writeByte('\n') catch break;
        stdout.interface.flush() catch break;
    }
}

fn readManifest(alloc: Allocator, path: []const u8) ![]u8 {
    var file = try std.Io.Dir.openFileAbsolute(io_mod.getIo(), path, .{});
    defer file.close(io_mod.getIo());
    const buffer = try alloc.alloc(u8, 64 * 1024);
    defer alloc.free(buffer);
    var reader = file.readerStreaming(io_mod.getIo(), buffer);
    const raw = try reader.interface.allocRemaining(alloc, .limited(max_manifest_bytes));
    defer alloc.free(raw);
    // Trim so the array splices cleanly into the tools/list result.
    return alloc.dupe(u8, std.mem.trim(u8, raw, " \t\r\n"));
}

/// Builds the JSON-RPC reply for one request, or null for a notification.
/// Exposed for tests; `manifest` is the pre-rendered `tools` array.
pub fn buildResponse(alloc: Allocator, request: []const u8, manifest: []const u8) !?[]u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, request, .{}) catch
        return error.InvalidBridgeRequest;
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidBridgeRequest;

    const method_value = parsed.value.object.get("method") orelse return error.InvalidBridgeRequest;
    if (method_value != .string) return error.InvalidBridgeRequest;
    const method = method_value.string;

    // Notifications carry no id and must not be answered.
    const id = parsed.value.object.get("id") orelse return null;

    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.writeAll("{\"jsonrpc\":\"2.0\",\"id\":");
    try std.json.Stringify.value(id, .{}, &out.writer);
    try out.writer.writeAll(",");

    if (std.mem.eql(u8, method, "initialize")) {
        try out.writer.print(
            "\"result\":{{\"protocolVersion\":\"{s}\",\"capabilities\":{{\"tools\":{{}}}}," ++
                "\"serverInfo\":{{\"name\":\"{s}\",\"version\":\"1.0.0\"}}}}}}",
            .{ protocol_version, server_name },
        );
        return try out.toOwnedSlice();
    }

    if (std.mem.eql(u8, method, "tools/list")) {
        try out.writer.writeAll("\"result\":{\"tools\":");
        try out.writer.writeAll(manifest);
        try out.writer.writeAll("}}");
        return try out.toOwnedSlice();
    }

    if (std.mem.eql(u8, method, "tools/call")) {
        // Deliberately unanswered. fx executes the tool itself and kills this
        // session the moment it sees the call in the stream. Returning an error
        // instead would surface a bogus tool failure to the model, which then
        // retries the call and never converges.
        out.deinit();
        return null;
    }

    try out.writer.writeAll("\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}");
    return try out.toOwnedSlice();
}

const testing = std.testing;

test "bridge mode is recognized only with an exact marker and manifest path" {
    const ok = [_][*:0]const u8{ "fx", bridge_mode, "/tmp/m.json" };
    try testing.expect(isBridgeModeRaw(&ok));

    const missing_path = [_][*:0]const u8{ "fx", bridge_mode };
    try testing.expect(!isBridgeModeRaw(&missing_path));

    const other = [_][*:0]const u8{ "fx", "ask", "hello" };
    try testing.expect(!isBridgeModeRaw(&other));
}

test "manifest renders fx tools in the shape tools/list expects" {
    const manifest = try manifestAlloc(testing.allocator, &.{
        .{ .name = "read", .description = "Read a file", .input_schema = .{} },
    });
    defer testing.allocator.free(manifest);

    try testing.expect(std.mem.indexOf(u8, manifest, "\"name\":\"read\"") != null);
    try testing.expect(std.mem.indexOf(u8, manifest, "\"description\":\"Read a file\"") != null);
    try testing.expect(std.mem.indexOf(u8, manifest, "\"inputSchema\":") != null);

    var parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, manifest, .{});
    defer parsed.deinit();
    try testing.expectEqual(@as(usize, 1), parsed.value.array.items.len);
}

test "an empty tool set still renders a valid array" {
    const manifest = try manifestAlloc(testing.allocator, &.{});
    defer testing.allocator.free(manifest);
    try testing.expectEqualStrings("[]", manifest);
}

test "initialize advertises tool capability and the fx server name" {
    const response = (try buildResponse(
        testing.allocator,
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}",
        "[]",
    )).?;
    defer testing.allocator.free(response);

    var parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, response, .{});
    defer parsed.deinit();
    const result = parsed.value.object.get("result").?.object;
    try testing.expectEqualStrings(protocol_version, result.get("protocolVersion").?.string);
    try testing.expect(result.get("capabilities").?.object.get("tools") != null);
    try testing.expectEqualStrings("fx", result.get("serverInfo").?.object.get("name").?.string);
    try testing.expectEqual(@as(i64, 1), parsed.value.object.get("id").?.integer);
}

test "tools/list returns the manifest verbatim" {
    const manifest = try manifestAlloc(testing.allocator, &.{
        .{ .name = "edit", .description = "Edit a file", .input_schema = .{} },
    });
    defer testing.allocator.free(manifest);

    const response = (try buildResponse(
        testing.allocator,
        "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/list\"}",
        manifest,
    )).?;
    defer testing.allocator.free(response);

    var parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, response, .{});
    defer parsed.deinit();
    const tools = parsed.value.object.get("result").?.object.get("tools").?.array;
    try testing.expectEqual(@as(usize, 1), tools.items.len);
    try testing.expectEqualStrings("edit", tools.items[0].object.get("name").?.string);
}

test "notifications get no reply" {
    try testing.expect((try buildResponse(
        testing.allocator,
        "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}",
        "[]",
    )) == null);
}

test "tools/call is left unanswered so the model never sees a bogus failure" {
    // fx runs the tool and ends the session; replying with an error would make
    // the model retry the call forever.
    try testing.expect((try buildResponse(
        testing.allocator,
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"read\"}}",
        "[]",
    )) == null);
}

test "unknown methods return a JSON-RPC method-not-found error" {
    const response = (try buildResponse(
        testing.allocator,
        "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"resources/list\"}",
        "[]",
    )).?;
    defer testing.allocator.free(response);

    var parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, response, .{});
    defer parsed.deinit();
    try testing.expectEqual(
        @as(i64, -32601),
        parsed.value.object.get("error").?.object.get("code").?.integer,
    );
}

test "string ids round-trip so clients that use them still match replies" {
    const response = (try buildResponse(
        testing.allocator,
        "{\"jsonrpc\":\"2.0\",\"id\":\"abc\",\"method\":\"tools/list\"}",
        "[]",
    )).?;
    defer testing.allocator.free(response);

    var parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, response, .{});
    defer parsed.deinit();
    try testing.expectEqualStrings("abc", parsed.value.object.get("id").?.string);
}

test "malformed requests are rejected without producing a reply" {
    try testing.expectError(
        error.InvalidBridgeRequest,
        buildResponse(testing.allocator, "not json", "[]"),
    );
    try testing.expectError(
        error.InvalidBridgeRequest,
        buildResponse(testing.allocator, "{\"jsonrpc\":\"2.0\",\"id\":1}", "[]"),
    );
}
