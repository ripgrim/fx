const std = @import("std");
const io_mod = @import("../shared/io.zig");
const mcp_runtime = @import("../tooling/tool_mcp_runtime.zig");

const source = @embedFile("helper.ts");
const inspector_source = @embedFile("inspector.ts");
const property_source = @embedFile("property_diff.ts");
const comparison_source = @embedFile("comparison.ts");

/// Prefer a native Bun install to Windows shims inherited through WSL's PATH.
/// Caller owns the returned executable path.
pub fn runtimeExecutable(alloc: std.mem.Allocator) ![]u8 {
    if (@import("builtin").os.tag == .linux) {
        if (io_mod.getenv("HOME")) |home| {
            const path = try std.fs.path.join(alloc, &.{ home, ".bun", "bin", "bun" });
            var file = std.Io.Dir.cwd().openFile(io_mod.getIo(), path, .{}) catch {
                alloc.free(path);
                return validatedRuntime(alloc, "bun");
            };
            defer file.close(io_mod.getIo());
            defer alloc.free(path);
            return validatedRuntime(alloc, path);
        }
    }
    return validatedRuntime(alloc, "bun");
}

fn validatedRuntime(alloc: std.mem.Allocator, executable: []const u8) ![]u8 {
    const result = std.process.run(alloc, io_mod.getIo(), .{ .argv = &.{ executable, "--eval", "process.stdout.write(process.platform)" } }) catch return error.DesignNativeBunRequired;
    defer alloc.free(result.stdout);
    defer alloc.free(result.stderr);
    const expected = switch (@import("builtin").os.tag) {
        .windows => "win32",
        .macos => "darwin",
        .linux => "linux",
        else => return error.DesignNativeBunRequired,
    };
    if (!std.mem.eql(u8, result.stdout, expected)) return error.DesignNativeBunRequired;
    return alloc.dupe(u8, executable);
}

/// Materialize the bundled helper by content identity. The caller owns the path.
pub fn ensureInstalled(alloc: std.mem.Allocator) ![]u8 {
    const home = io_mod.getenv("HOME") orelse io_mod.getenv("USERPROFILE") orelse return error.HomeNotSet;
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(source ++ inspector_source ++ property_source ++ comparison_source, &digest, .{});
    const identity = std.fmt.bytesToHex(digest, .lower);
    const directory = try std.fs.path.join(alloc, &.{ home, ".fx", "helpers", "design", &identity });
    defer alloc.free(directory);
    try io_mod.makeDirRecursive(directory);
    const comparison_path = try std.fs.path.join(alloc, &.{ directory, "comparison.ts" });
    defer alloc.free(comparison_path);
    if (std.Io.Dir.cwd().openFile(io_mod.getIo(), comparison_path, .{})) |comparison_file| {
        var file = comparison_file;
        defer file.close(io_mod.getIo());
        const bytes = try io_mod.readFileToEnd(alloc, &file, comparison_source.len + 1);
        defer alloc.free(bytes);
        if (!std.mem.eql(u8, bytes, comparison_source)) return error.DesignHelperIntegrityMismatch;
    } else |err| switch (err) {
        error.FileNotFound => try io_mod.writeFileAtomic(alloc, comparison_path, comparison_source),
        else => return err,
    }
    const property_path = try std.fs.path.join(alloc, &.{ directory, "property_diff.ts" });
    defer alloc.free(property_path);
    if (std.Io.Dir.cwd().openFile(io_mod.getIo(), property_path, .{})) |property_file| {
        var file = property_file;
        defer file.close(io_mod.getIo());
        const bytes = try io_mod.readFileToEnd(alloc, &file, property_source.len + 1);
        defer alloc.free(bytes);
        if (!std.mem.eql(u8, bytes, property_source)) return error.DesignHelperIntegrityMismatch;
    } else |err| switch (err) {
        error.FileNotFound => try io_mod.writeFileAtomic(alloc, property_path, property_source),
        else => return err,
    }
    const inspector_path = try std.fs.path.join(alloc, &.{ directory, "inspector.ts" });
    defer alloc.free(inspector_path);
    if (std.Io.Dir.cwd().openFile(io_mod.getIo(), inspector_path, .{})) |inspector_file| {
        var file = inspector_file;
        defer file.close(io_mod.getIo());
        const bytes = try io_mod.readFileToEnd(alloc, &file, inspector_source.len + 1);
        defer alloc.free(bytes);
        if (!std.mem.eql(u8, bytes, inspector_source)) return error.DesignHelperIntegrityMismatch;
    } else |err| switch (err) {
        error.FileNotFound => try io_mod.writeFileAtomic(alloc, inspector_path, inspector_source),
        else => return err,
    }
    const path = try std.fs.path.join(alloc, &.{ directory, "helper.ts" });
    defer alloc.free(path);
    // Content-addressed versions are immutable; never overwrite a running helper.
    var existing = std.Io.Dir.cwd().openFile(io_mod.getIo(), path, .{}) catch |err| switch (err) {
        error.FileNotFound => {
            try io_mod.writeFileAtomic(alloc, path, source);
            return writeLauncher(alloc, home, path);
        },
        else => return err,
    };
    defer existing.close(io_mod.getIo());
    const bytes = try io_mod.readFileToEnd(alloc, &existing, source.len + 1);
    defer alloc.free(bytes);
    if (!std.mem.eql(u8, bytes, source)) return error.DesignHelperIntegrityMismatch;
    return writeLauncher(alloc, home, path);
}

fn writeLauncher(alloc: std.mem.Allocator, home: []const u8, source_path: []const u8) ![]u8 {
    const launcher = try std.fs.path.join(alloc, &.{ home, ".fx", "helpers", "design", "v1.ts" });
    errdefer alloc.free(launcher);
    var text: std.Io.Writer.Allocating = .init(alloc);
    defer text.deinit();
    try text.writer.writeAll("import { serve } from ");
    try std.json.Stringify.value(source_path, .{}, &text.writer);
    try text.writer.writeAll(";\nawait serve();\n");
    try io_mod.writeFileAtomic(alloc, launcher, text.written());
    return launcher;
}

/// Caller owns the returned path. Session identities never become unchecked paths.
pub fn sessionDirectory(alloc: std.mem.Allocator, maybe_session_id: ?[]const u8) ![]u8 {
    const session_id = maybe_session_id orelse return error.DesignSessionRequired;
    if (session_id.len == 0 or session_id.len > 100) return error.DesignSessionRequired;
    for (session_id) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and byte != '-' and byte != '_') return error.InvalidDesignSession;
    }
    const home = io_mod.getenv("HOME") orelse io_mod.getenv("USERPROFILE") orelse return error.HomeNotSet;
    return std.fs.path.join(alloc, &.{ home, ".fx", "sessions", session_id });
}

/// Bind helper calls to the host's session, replacing any model-supplied storage path.
pub fn bindArguments(alloc: std.mem.Allocator, arguments: []const u8, session_id: ?[]const u8) ![]u8 {
    const directory = try sessionDirectory(alloc, session_id);
    defer alloc.free(directory);
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, arguments, .{ .allocate = .alloc_always });
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidDesignArguments;
    try parsed.value.object.put(parsed.arena.allocator(), "session_directory", .{ .string = directory });
    var writer: std.Io.Writer.Allocating = .init(alloc);
    defer writer.deinit();
    try std.json.Stringify.value(parsed.value, .{}, &writer.writer);
    return writer.toOwnedSlice();
}

/// Decode a host-observed MCP envelope. Caller owns the returned JSON bytes.
pub fn resultJson(alloc: std.mem.Allocator, output: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, output, .{});
    defer parsed.deinit();
    var value = parsed.value;
    if (value == .object) {
        if (value.object.get("result")) |result| value = result;
    }
    if (value == .object) {
        if (value.object.get("isError")) |flag| {
            if (flag == .bool and flag.bool) return error.DesignMcpResultFailed;
        }
        if (value.object.get("structuredContent")) |structured| {
            value = structured;
        } else if (value.object.get("content")) |content| {
            if (content != .array) return error.InvalidDesignMcpResult;
            for (content.array.items) |item| {
                if (item != .object) continue;
                if (item.object.get("text")) |text| {
                    if (text == .string) return alloc.dupe(u8, text.string);
                }
            }
            return error.InvalidDesignMcpResult;
        }
    }
    var writer: std.Io.Writer.Allocating = .init(alloc);
    defer writer.deinit();
    try std.json.Stringify.value(value, .{}, &writer.writer);
    return writer.toOwnedSlice();
}

/// Checkpoints are bound to the admitted capture, never a guessed child-node ID.
pub fn checkpointArguments(alloc: std.mem.Allocator, proof_json: []const u8) ![]u8 {
    const Proof = struct { capture_id: []const u8 };
    var proof = try std.json.parseFromSlice(Proof, alloc, proof_json, .{ .ignore_unknown_fields = true });
    defer proof.deinit();
    return std.json.Stringify.valueAlloc(alloc, .{ .capture_id = proof.value.capture_id }, .{});
}

/// Only the bundled helper can request this task-bound browser surface.
/// Caller owns the notice. The link is also the reopen action in the transcript.
pub fn inspectorNotice(alloc: std.mem.Allocator, output: []const u8, interactive: bool) !?[]u8 {
    const View = struct { state: []const u8, url: []const u8, auto_open: bool = false, unavailable: bool = false };
    const Envelope = struct { inspector: ?View = null };
    var parsed = std.json.parseFromSlice(Envelope, alloc, output, .{ .ignore_unknown_fields = true }) catch return null;
    defer parsed.deinit();
    const view = parsed.value.inspector orelse return null;
    if (view.unavailable) return try alloc.dupe(u8, "Visual inspector unavailable; verification evidence is saved. The saved local endpoint could not be opened safely.");
    if (!std.mem.startsWith(u8, view.url, "http://127.0.0.1:") or view.url.len > 200) return null;
    for (view.url) |byte| if (!std.ascii.isAlphanumeric(byte) and std.mem.findScalar(u8, ":/.-", byte) == null) return null;
    if (interactive and view.auto_open and !@import("builtin").is_test and @import("builtin").os.tag != .wasi) {
        _ = try open_inspector(alloc, view.url);
    }
    const state = if (std.mem.eql(u8, view.state, "verified")) "verified" else if (std.mem.eql(u8, view.state, "needs-repair")) "needs repair" else if (std.mem.eql(u8, view.state, "building")) "building" else if (std.mem.eql(u8, view.state, "checking")) "checking" else "outdated";
    return try std.fmt.allocPrint(alloc, "{s}\nReview diff: {s}", .{ state, view.url });
}

/// Borrow the latest host-produced checkpoint link from session transcript evidence.
/// A newer pending/unavailable checkpoint supersedes an older ready preview.
pub fn latest_inspector_url(entries: anytype) ?[]const u8 {
    var index = entries.len;
    while (index > 0) {
        index -= 1;
        const entry = entries[index];
        if (entry != .semantic_notice) continue;
        const notice = entry.semantic_notice;
        if (std.mem.eql(u8, notice.topic, "diff")) {
            const prefix = "ready · \x1b]8;;";
            if (!std.mem.startsWith(u8, notice.body, prefix)) return null;
            const end = std.mem.findPos(u8, notice.body, prefix.len, "\x1b\\") orelse return null;
            const url = notice.body[prefix.len..end];
            if (!validDiffUrl(url)) return null;
            return url;
        }
        if (!std.mem.eql(u8, notice.topic, "design verification")) continue;
        return ready_notice_url(notice.body);
    }
    return null;
}

fn validDiffUrl(url: []const u8) bool {
    if (!std.mem.startsWith(u8, url, "http://127.0.0.1:") or url.len > 200) return false;
    for (url) |byte| if (!std.ascii.isAlphanumeric(byte) and std.mem.findScalar(u8, ":/.-", byte) == null) return false;
    return true;
}

/// Caller owns the host-only, terminal-safe clickable command result.
pub fn diffNotice(alloc: std.mem.Allocator, url: []const u8) ![]u8 {
    if (!validDiffUrl(url)) return error.InvalidDiffUrl;
    return std.fmt.allocPrint(alloc, "ready · \x1b]8;;{s}\x1b\\Open viewer ↗\x1b]8;;\x1b\\", .{url});
}

fn ready_notice_url(body: []const u8) ?[]const u8 {
    const prefix = if (std.mem.startsWith(u8, body, "verified\nReview diff: "))
        "verified\nReview diff: "
    else if (std.mem.startsWith(u8, body, "needs repair\nReview diff: "))
        "needs repair\nReview diff: "
    else
        return null;
    const url = body[prefix.len..];
    if (!std.mem.startsWith(u8, url, "http://127.0.0.1:") or url.len > 200) return null;
    for (url) |byte| if (!std.ascii.isAlphanumeric(byte) and std.mem.findScalar(u8, ":/.-", byte) == null) return null;
    return url;
}

/// Reuse the same platform/WSL launcher as automatic inspector presentation.
pub fn open_inspector(alloc: std.mem.Allocator, url: []const u8) !bool {
    if (!std.mem.startsWith(u8, url, "http://127.0.0.1:") or url.len > 200) return false;
    for (url) |byte| if (!std.ascii.isAlphanumeric(byte) and std.mem.findScalar(u8, ":/.-", byte) == null) return false;
    if (@import("builtin").is_test) return true;
    if (@import("builtin").os.tag == .wasi) return false;
    if (@import("../hosts/url_opener.zig").native_opener.open(alloc, url) catch false) return true;
    if (@import("builtin").os.tag != .linux or io_mod.getenv("WSL_INTEROP") == null) return false;
    const command = try std.fmt.allocPrint(alloc, "Start-Process -FilePath '{s}' -WindowStyle Hidden", .{url});
    defer alloc.free(command);
    const launched = std.process.run(alloc, io_mod.getIo(), .{ .argv = &.{ "powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command } }) catch return false;
    defer alloc.free(launched.stdout);
    defer alloc.free(launched.stderr);
    return switch (launched.term) {
        .exited => |code| code == 0,
        else => false,
    };
}

test "design diff shortcut requires a ready safe checkpoint" {
    try std.testing.expect(ready_notice_url("building\nReview diff: http://127.0.0.1:1234/a/view") == null);
    try std.testing.expect(ready_notice_url("checking\nReview diff: http://127.0.0.1:1234/a/view") == null);
    try std.testing.expect(ready_notice_url("verified\nReview diff: https://example.com") == null);
    try std.testing.expect(ready_notice_url("verified\nReview diff: http://127.0.0.1:1234/\x1b") == null);
    try std.testing.expectEqualStrings("http://127.0.0.1:1234/a/view", ready_notice_url("needs repair\nReview diff: http://127.0.0.1:1234/a/view").?);
}

/// Host-owned receipt. Both inputs are actual MCP outputs, never assistant claims.
pub fn recordResult(
    alloc: std.mem.Allocator,
    context: *anyopaque,
    call: mcp_runtime.CallToolFn,
    options: mcp_runtime.CallOptions,
    session_id: ?[]const u8,
    preflight_output: []const u8,
    paper_output: []const u8,
    max_bytes: usize,
) !void {
    const Proof = struct { capture_id: []const u8, operation_hash: []const u8 };
    var proof = try std.json.parseFromSlice(Proof, alloc, preflight_output, .{ .ignore_unknown_fields = true });
    defer proof.deinit();
    const directory = try sessionDirectory(alloc, session_id);
    defer alloc.free(directory);
    var writer: std.Io.Writer.Allocating = .init(alloc);
    defer writer.deinit();
    const paper_json = try resultJson(alloc, paper_output);
    defer alloc.free(paper_json);
    // Retain the complete host-observed receipt before any downstream RPC or
    // model-facing truncation. Recovery never repeats the Paper mutation.
    if (proof.value.operation_hash.len != 64) return error.InvalidDesignOperation;
    for (proof.value.operation_hash) |byte| if (!std.ascii.isHex(byte)) return error.InvalidDesignOperation;
    if (proof.value.capture_id.len == 0 or proof.value.capture_id.len > 100) return error.InvalidDesignOperation;
    for (proof.value.capture_id) |byte| if (!std.ascii.isAlphanumeric(byte) and byte != '-' and byte != '_') return error.InvalidDesignOperation;
    const receipt_path = try std.fmt.allocPrint(alloc, "{s}/design/{s}-{s}.receipt", .{ directory, proof.value.capture_id, proof.value.operation_hash });
    defer alloc.free(receipt_path);
    try std.Io.Dir.cwd().createDirPath(io_mod.getIo(), std.fs.path.dirname(receipt_path).?);
    try io_mod.writeFileAtomic(alloc, receipt_path, paper_json);
    try std.json.Stringify.value(.{
        .capture_id = proof.value.capture_id,
        .operation_hash = proof.value.operation_hash,
        .session_directory = directory,
        .result_json = paper_json,
    }, .{}, &writer.writer);
    var result = try call(context, alloc, "mcp_fx_design_record_result", writer.written(), max_bytes, options) orelse return error.DesignReceiptMissing;
    defer result.deinit(alloc);
    const Receipt = struct { status: []const u8 };
    const receipt_json = try resultJson(alloc, result.model_output);
    defer alloc.free(receipt_json);
    var receipt = try std.json.parseFromSlice(Receipt, alloc, receipt_json, .{ .ignore_unknown_fields = true });
    defer receipt.deinit();
    if (!std.mem.eql(u8, receipt.value.status, "recorded") and !std.mem.eql(u8, receipt.value.status, "already-recorded")) return error.DesignReceiptRejected;
}

test "design host decodes MCP envelopes and rejects tool errors" {
    const alloc = std.testing.allocator;
    const structured = try resultJson(alloc, "{\"server\":\"fx_design\",\"result\":{\"structuredContent\":{\"status\":\"clean\"},\"content\":[]}}");
    defer alloc.free(structured);
    try std.testing.expectEqualStrings("{\"status\":\"clean\"}", structured);
    const text = try resultJson(alloc, "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"id\\\":\\\"artboard\\\"}\"}]}}");
    defer alloc.free(text);
    try std.testing.expectEqualStrings("{\"id\":\"artboard\"}", text);
    try std.testing.expectError(error.DesignMcpResultFailed, resultJson(alloc, "{\"result\":{\"isError\":true,\"structuredContent\":{\"status\":\"clean\"}}}"));
}

test "design session identities cannot escape storage" {
    try std.testing.expectError(error.InvalidDesignSession, sessionDirectory(std.testing.allocator, "../outside"));
    try std.testing.expectError(error.DesignSessionRequired, sessionDirectory(std.testing.allocator, ""));
}

test "diff command links reject remote and terminal-control URLs" {
    const alloc = std.testing.allocator;
    const notice = try diffNotice(alloc, "http://127.0.0.1:1234/a/view");
    defer alloc.free(notice);
    try std.testing.expect(std.mem.find(u8, notice, "Open viewer ↗") != null);
    try std.testing.expectError(error.InvalidDiffUrl, diffNotice(alloc, "https://example.com"));
    try std.testing.expectError(error.InvalidDiffUrl, diffNotice(alloc, "http://127.0.0.1:1234/\x1b[2J"));
}

test "design inspector notices reject nonlocal and terminal-control URLs" {
    const alloc = std.testing.allocator;
    try std.testing.expect((try inspectorNotice(alloc, "{\"inspector\":{\"state\":\"verified\",\"url\":\"https://evil.example\",\"auto_open\":true}}", false)) == null);
    try std.testing.expect((try inspectorNotice(alloc, "{\"inspector\":{\"state\":\"verified\",\"url\":\"http://127.0.0.1:1234/\\u001b\"}}", false)) == null);
    const notice = (try inspectorNotice(alloc, "{\"inspector\":{\"state\":\"needs-repair\",\"url\":\"http://127.0.0.1:1234/a/b/view\"}}", false)).?;
    defer alloc.free(notice);
    try std.testing.expect(std.mem.startsWith(u8, notice, "needs repair\nReview diff:"));
}

test "design helper rejects an unavailable runtime before registration" {
    try std.testing.expectError(error.DesignNativeBunRequired, validatedRuntime(std.testing.allocator, "fx-design-nonexistent-runtime-79c3"));
}
