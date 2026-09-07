const std = @import("std");
const mcp_command_provider = @import("../mcp/command_provider.zig");

pub const id = "design";
pub const name = "Design";
pub const description = "Design against live codebase components and tokens with regression checks";

pub const default_canvas_server_name = "paper";
pub const default_canvas_server_url = "http://127.0.0.1:29979/mcp";

pub const McpSetupOutcome = enum {
    already_configured,
    installed,
    installed_reload_failed,
};

pub fn defaultCanvasServerIntent() mcp_command_provider.AddIntent {
    return .{ .http = .{
        .name = default_canvas_server_name,
        .url = default_canvas_server_url,
    } };
}

pub fn authorizesCanvasTool(mode_id: []const u8, tool_name: []const u8) bool {
    if (!std.mem.eql(u8, mode_id, id)) return false;
    if (std.mem.startsWith(u8, tool_name, "mcp_paper_")) return true;
    const design_tools = [_][]const u8{
        "mcp_fx_design_discover",
        "mcp_fx_design_capture_source",
        "mcp_fx_design_source_tree",
        "mcp_fx_design_prepare_import",
        "mcp_fx_design_prepare_edit",
        "mcp_fx_design_execute",
        "mcp_fx_design_inspect",
        "mcp_fx_design_compare",
        "mcp_fx_design_check",
        "mcp_fx_design_verify",
        "mcp_fx_design_preflight",
    };
    for (design_tools) |design_tool| {
        if (std.mem.eql(u8, tool_name, design_tool)) return true;
    }
    return false;
}

/// Returns an allocator-owned regression message when a Paper mutation violates Design mode.
pub fn paper_mutation_regression(
    alloc: std.mem.Allocator,
    mode_id: []const u8,
    tool_name: []const u8,
    arguments_json: []const u8,
    root_user_intent: []const u8,
    source_validated: bool,
) !?[]const u8 {
    if (!std.mem.eql(u8, mode_id, id) or
        !std.mem.startsWith(u8, tool_name, "mcp_paper_")) return null;
    // The managed adapter admits an exact prepared payload with source provenance.
    // Do not reclassify mechanically preserved assets or imported tokens by keywords.
    if (source_validated) return null;

    if ((std.mem.eql(u8, tool_name, "mcp_paper_create_tokens") or
        std.mem.eql(u8, tool_name, "mcp_paper_set_tokens")) and
        !explicitly_requests_token_mutation(root_user_intent))
    {
        return try alloc.dupe(u8, "design-check: regression — 1 finding(s)\n" ++
            "summary: token mutation: 1; shape drift: 0; hardcoded colors: 0; redrawn vectors: 0\n" ++
            "[REGRESSION] Paper tokens > mutation: [canvas] create or redefine tokens; [codebase] reuse existing token names and values.\n" ++
            "Use mcp_paper_get_tokens and bind existing tokens. Only mutate token definitions when the root user explicitly requests it.");
    }

    if (!std.mem.eql(u8, tool_name, "mcp_paper_write_html") and
        !std.mem.eql(u8, tool_name, "mcp_paper_update_styles")) return null;

    var parsed = std.json.parseFromSlice(std.json.Value, alloc, arguments_json, .{}) catch return null;
    defer parsed.deinit();

    if (contains_token_definition(parsed.value) and
        !explicitly_requests_token_mutation(root_user_intent))
    {
        return try alloc.dupe(u8, "design-check: regression — 1 finding(s)\n" ++
            "summary: token mutation: 1; shape drift: 0; hardcoded colors: 0; redrawn vectors: 0\n" ++
            "[REGRESSION] Paper write > token: [canvas] newly defined CSS custom property; [codebase] existing token binding.\n" ++
            "Remove the custom-property declaration, inspect the source and Paper token catalogs, and reference the existing token with var(--token-name).");
    }

    if (std.mem.eql(u8, tool_name, "mcp_paper_write_html") and
        contains_authored_vector(parsed.value) and
        !source_validated and
        !explicitly_requests_authored_vector(root_user_intent))
    {
        return try alloc.dupe(u8, "design-check: regression — 1 finding(s)\n" ++
            "summary: token mutation: 0; shape drift: 0; hardcoded colors: 0; redrawn vectors: 1\n" ++
            "[REGRESSION] Paper write > vector: [canvas] newly authored SVG/vector geometry; [codebase] exact existing asset or component.\n" ++
            "Clone or duplicate the existing Paper node, use <x-paper-clone node-id=\"...\" />, or place the exact source asset. Do not approximate icons or illustrations from perception.");
    }

    const generated_source_write = source_validated and std.mem.eql(u8, tool_name, "mcp_paper_write_html");
    if (!generated_source_write) {
        if (first_raw_color(parsed.value)) |raw_color| {
            return try std.fmt.allocPrint(
                alloc,
                "design-check: regression — 1 finding(s)\n" ++
                    "summary: token mutation: 0; shape drift: 0; hardcoded colors: 1; redrawn vectors: 0\n" ++
                    "[REGRESSION] Paper write > color: [canvas] {s}; [codebase] matching design token.\n" ++
                    "Resolve the codebase token by name and value, then bind it with var(--token-name). A matching raw value still counts as drift.",
                .{raw_color},
            );
        }
    }

    return null;
}

pub fn automatic_preflight_arguments(
    alloc: std.mem.Allocator,
    mode_id: []const u8,
    tool_name: []const u8,
    arguments_json: []const u8,
) !?[]u8 {
    if (!std.mem.eql(u8, mode_id, id) or !isPaperMutationTool(tool_name)) return null;
    var output: std.Io.Writer.Allocating = .init(alloc);
    defer output.deinit();
    try output.writer.writeAll("{\"paperTool\":");
    try std.json.Stringify.value(tool_name, .{}, &output.writer);
    try output.writer.writeAll(",\"argumentsJson\":");
    try std.json.Stringify.value(arguments_json, .{}, &output.writer);
    try output.writer.writeByte('}');
    return try output.toOwnedSlice();
}

pub fn automatic_preflight_clean(output: []const u8) bool {
    return clean_proof(output, false);
}

/// Returns allocator-owned arguments for the automatic project design checkpoint.
pub fn automatic_check_arguments(
    alloc: std.mem.Allocator,
    mode_id: []const u8,
    tool_name: []const u8,
    arguments_json: []const u8,
) !?[]u8 {
    if (!std.mem.eql(u8, mode_id, id)) return null;
    if (!std.mem.eql(u8, tool_name, "mcp_paper_write_html") and
        !std.mem.eql(u8, tool_name, "mcp_paper_update_styles")) return null;

    var parsed = std.json.parseFromSlice(std.json.Value, alloc, arguments_json, .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const object = parsed.value.object;
    const node_id = if (std.mem.eql(u8, tool_name, "mcp_paper_write_html")) blk: {
        const value = object.get("targetNodeId") orelse return null;
        if (value != .string) return null;
        break :blk value.string;
    } else blk: {
        const updates = object.get("updates") orelse return null;
        if (updates != .array or updates.array.items.len == 0) return null;
        const update = updates.array.items[0];
        if (update != .object) return null;
        const node_ids = update.object.get("nodeIds") orelse return null;
        if (node_ids != .array or node_ids.array.items.len == 0) return null;
        const value = node_ids.array.items[0];
        if (value != .string) return null;
        break :blk value.string;
    };
    const file_id = if (object.get("fileId")) |value|
        if (value == .string) value.string else null
    else
        null;

    var output: std.Io.Writer.Allocating = .init(alloc);
    defer output.deinit();
    try output.writer.writeAll("{\"nodeId\":");
    try std.json.Stringify.value(node_id, .{}, &output.writer);
    if (file_id) |value| {
        try output.writer.writeAll(",\"fileId\":");
        try std.json.Stringify.value(value, .{}, &output.writer);
    }
    try output.writer.writeByte('}');
    return try output.toOwnedSlice();
}

pub fn automatic_check_clean(output: []const u8) bool {
    if (clean_proof(output, true)) return true;
    var storage: [65536]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&storage);
    const decoded = @import("../design/managed_helper.zig").resultJson(fixed.allocator(), output) catch return false;
    return clean_proof(decoded, true);
}

pub fn automatic_check_pending(output: []const u8) bool {
    const Pending = struct { version: u8, status: []const u8, capture_id: []const u8, source_revision: []const u8 };
    var storage: [4096]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&storage);
    var parsed = std.json.parseFromSlice(Pending, fixed.allocator(), output, .{ .ignore_unknown_fields = true }) catch return false;
    defer parsed.deinit();
    return parsed.value.version == 1 and std.mem.eql(u8, parsed.value.status, "pending") and parsed.value.capture_id.len > 0 and parsed.value.source_revision.len == 64;
}

fn clean_proof(output: []const u8, verification: bool) bool {
    const Proof = struct {
        version: u8,
        status: []const u8,
        capture_id: []const u8,
        source_revision: []const u8,
        operation_hash: []const u8 = "",
        artboard_id: []const u8 = "",
        canvas_revision: []const u8 = "",
        phase: []const u8 = "",
        pending_verifications: usize = std.math.maxInt(usize),
    };
    var storage: [16384]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&storage);
    var parsed = std.json.parseFromSlice(Proof, fixed.allocator(), output, .{ .ignore_unknown_fields = true }) catch return false;
    defer parsed.deinit();
    const proof = parsed.value;
    if (proof.version != 1 or !std.mem.eql(u8, proof.status, "clean") or proof.capture_id.len == 0 or proof.source_revision.len != 64) return false;
    if (!verification) return proof.operation_hash.len == 64;
    return proof.pending_verifications == 0 and proof.artboard_id.len > 0 and proof.canvas_revision.len == 64 and
        (std.mem.eql(u8, proof.phase, "import") or std.mem.eql(u8, proof.phase, "design") or std.mem.eql(u8, proof.phase, "apply"));
}

pub fn isPaperMutationTool(tool_name: []const u8) bool {
    const prefix = "mcp_paper_";
    if (!std.mem.startsWith(u8, tool_name, prefix)) return false;
    const action = tool_name[prefix.len..];
    const mutation_prefixes = [_][]const u8{
        "create_", "write_",     "update_", "set_",    "delete_",
        "remove_", "duplicate_", "move_",   "rename_", "reorder_",
        "insert_", "replace_",
    };
    for (mutation_prefixes) |mutation_prefix| {
        if (std.mem.startsWith(u8, action, mutation_prefix)) return true;
    }
    return false;
}

pub fn updateFinalVerificationRequired(
    currently_required: bool,
    mode_id: []const u8,
    tool_name: []const u8,
    succeeded: bool,
    output: []const u8,
) bool {
    if (!std.mem.eql(u8, mode_id, id) or !succeeded) return currently_required;
    if (std.mem.eql(u8, tool_name, "mcp_fx_design_execute") or isPaperMutationTool(tool_name)) {
        const marker = "\n\n[AUTOMATIC DESIGN CHECK]\n";
        if (std.mem.lastIndexOf(u8, output, marker)) |index| {
            if (automatic_check_clean(output[index + marker.len ..])) return false;
        }
        return true;
    }
    if (std.mem.eql(u8, tool_name, "mcp_design_import_source")) return true;
    if (std.mem.eql(u8, tool_name, "mcp_fx_design_prepare_import") or std.mem.eql(u8, tool_name, "mcp_fx_design_prepare_edit")) return true;
    if ((std.mem.eql(u8, tool_name, "mcp_fx_design_verify") or std.mem.eql(u8, tool_name, "mcp_fx_design_check")) and automatic_check_clean(output)) return false;
    return currently_required;
}

fn explicitly_requests_token_mutation(intent: []const u8) bool {
    const phrases = [_][]const u8{
        "create token", "create a token", "create new token", "update token",
        "edit token",   "change token",   "delete token",     "remove token",
        "set token",    "import token",   "sync token",       "reseed token",
    };
    return contains_any_non_negated_ascii_case_insensitive(intent, &phrases);
}

fn explicitly_requests_authored_vector(intent: []const u8) bool {
    const phrases = [_][]const u8{
        "draw svg",    "redraw svg",    "create svg",    "custom svg",
        "draw vector", "create vector", "custom vector", "vector illustration",
    };
    return contains_any_non_negated_ascii_case_insensitive(intent, &phrases);
}

fn contains_any_ascii_case_insensitive(haystack: []const u8, needles: []const []const u8) bool {
    for (needles) |needle| {
        if (std.ascii.indexOfIgnoreCase(haystack, needle) != null) return true;
    }
    return false;
}

fn contains_any_non_negated_ascii_case_insensitive(haystack: []const u8, needles: []const []const u8) bool {
    for (needles) |needle| {
        var offset: usize = 0;
        while (offset < haystack.len) {
            const relative = std.ascii.indexOfIgnoreCase(haystack[offset..], needle) orelse break;
            const start = offset + relative;
            const context_start = start -| 24;
            const prefix = haystack[context_start..start];
            const negations = [_][]const u8{ "do not ", "don't ", "never ", "not ", "without " };
            if (!contains_any_ascii_case_insensitive(prefix, &negations)) return true;
            offset = start + needle.len;
        }
    }
    return false;
}

fn contains_authored_vector(value: std.json.Value) bool {
    return switch (value) {
        .string => |text| contains_vector_markup(text),
        .array => |items| blk: {
            for (items.items) |item| if (contains_authored_vector(item)) break :blk true;
            break :blk false;
        },
        .object => |object| blk: {
            var iterator = object.iterator();
            while (iterator.next()) |entry| {
                if (contains_authored_vector(entry.value_ptr.*)) break :blk true;
            }
            break :blk false;
        },
        else => false,
    };
}

fn contains_token_definition(value: std.json.Value) bool {
    return switch (value) {
        .string => |text| contains_custom_property_declaration(text),
        .array => |items| blk: {
            for (items.items) |item| if (contains_token_definition(item)) break :blk true;
            break :blk false;
        },
        .object => |object| blk: {
            var iterator = object.iterator();
            while (iterator.next()) |entry| {
                if (std.mem.startsWith(u8, entry.key_ptr.*, "--") or
                    contains_token_definition(entry.value_ptr.*)) break :blk true;
            }
            break :blk false;
        },
        else => false,
    };
}

fn contains_custom_property_declaration(text: []const u8) bool {
    var offset: usize = 0;
    while (std.mem.indexOfPos(u8, text, offset, "--")) |start| {
        var end = start + 2;
        while (end < text.len and
            (std.ascii.isAlphanumeric(text[end]) or text[end] == '-' or text[end] == '_')) : (end += 1)
        {}
        while (end < text.len and std.ascii.isWhitespace(text[end])) : (end += 1) {}
        if (end < text.len and text[end] == ':') return true;
        offset = start + 2;
    }
    return false;
}

fn contains_vector_markup(text: []const u8) bool {
    if (std.ascii.indexOfIgnoreCase(text, "data:image/svg+xml") != null or
        std.ascii.indexOfIgnoreCase(text, "paper-gen://") != null) return true;
    const tags = [_][]const u8{
        "<svg", "<path", "<polygon", "<polyline", "<circle", "<ellipse", "<line",
    };
    for (tags) |tag| {
        var offset: usize = 0;
        while (offset < text.len) {
            const relative = std.ascii.indexOfIgnoreCase(text[offset..], tag) orelse break;
            const end = offset + relative + tag.len;
            if (end == text.len or text[end] == '>' or text[end] == '/' or std.ascii.isWhitespace(text[end])) return true;
            offset = end;
        }
    }
    return false;
}

fn first_raw_color(value: std.json.Value) ?[]const u8 {
    return switch (value) {
        .string => |text| raw_color_in_text(text),
        .array => |items| blk: {
            for (items.items) |item| {
                if (first_raw_color(item)) |color| break :blk color;
            }
            break :blk null;
        },
        .object => |object| blk: {
            var iterator = object.iterator();
            while (iterator.next()) |entry| {
                if (first_raw_color(entry.value_ptr.*)) |color| break :blk color;
            }
            break :blk null;
        },
        else => null,
    };
}

fn raw_color_in_text(text: []const u8) ?[]const u8 {
    var index: usize = 0;
    while (index < text.len) : (index += 1) {
        if (text[index] == '#') {
            var end = index + 1;
            while (end < text.len and std.ascii.isHex(text[end]) and end - index <= 8) : (end += 1) {}
            const digits = end - index - 1;
            if ((digits == 3 or digits == 4 or digits == 6 or digits == 8) and
                (end == text.len or !std.ascii.isHex(text[end]))) return text[index..end];
        }
    }

    const functions = [_][]const u8{
        "rgb(", "rgba(", "hsl(",   "hsla(",  "hwb(",
        "lab(", "lch(",  "oklab(", "oklch(", "color(",
    };
    for (functions) |function| {
        if (std.ascii.indexOfIgnoreCase(text, function)) |start| {
            const suffix = text[start..];
            const end = (std.mem.indexOfScalar(u8, suffix, ')') orelse
                @min(function.len + 24, suffix.len - 1)) + 1;
            return suffix[0..end];
        }
    }
    return null;
}

test "Design mode authorizes only Paper MCP tools" {
    try std.testing.expect(authorizesCanvasTool(id, "mcp_paper_write_html"));
    try std.testing.expect(authorizesCanvasTool(id, "mcp_fx_design_capture_source"));
    try std.testing.expect(!authorizesCanvasTool(id, "mcp_design_import_source"));
    try std.testing.expect(!authorizesCanvasTool("code", "mcp_paper_write_html"));
    try std.testing.expect(!authorizesCanvasTool(id, "mcp_other_write_html"));
}

test "Design gate blocks token recreation without explicit root intent" {
    const alloc = std.testing.allocator;
    const regression = (try paper_mutation_regression(
        alloc,
        id,
        "mcp_paper_create_tokens",
        "{\"tokens\":[]}",
        "Recreate the screen with existing tokens.",
        false,
    )).?;
    defer alloc.free(regression);
    try std.testing.expect(std.mem.indexOf(u8, regression, "token mutation: 1") != null);

    try std.testing.expect((try paper_mutation_regression(
        alloc,
        id,
        "mcp_paper_create_tokens",
        "{\"tokens\":[]}",
        "Create new tokens for this experimental theme.",
        false,
    )) == null);

    const negated = (try paper_mutation_regression(
        alloc,
        id,
        "mcp_paper_set_tokens",
        "{\"tokens\":[]}",
        "Do not create tokens; reuse the codebase tokens.",
        false,
    )).?;
    defer alloc.free(negated);
}

test "Design gate blocks raw colors and authored vectors" {
    const alloc = std.testing.allocator;
    const color_regression = (try paper_mutation_regression(
        alloc,
        id,
        "mcp_paper_write_html",
        "{\"html\":\"<div style='color: #ff00aa'>Hi</div>\"}",
        "Build the screen.",
        false,
    )).?;
    defer alloc.free(color_regression);
    try std.testing.expect(std.mem.indexOf(u8, color_regression, "#ff00aa") != null);

    const vector_regression = (try paper_mutation_regression(
        alloc,
        id,
        "mcp_paper_write_html",
        "{\"html\":\"<svg><path d='M0 0'/></svg>\"}",
        "Build the screen.",
        false,
    )).?;
    defer alloc.free(vector_regression);
    try std.testing.expect(std.mem.indexOf(u8, vector_regression, "redrawn vector") != null);

    const token_regression = (try paper_mutation_regression(
        alloc,
        id,
        "mcp_paper_write_html",
        "{\"html\":\"<div style='--new-surface: white; color: var(--new-surface)'>Hi</div>\"}",
        "Build the screen with existing tokens.",
        false,
    )).?;
    defer alloc.free(token_regression);
    try std.testing.expect(std.mem.indexOf(u8, token_regression, "newly defined CSS custom property") != null);

    try std.testing.expect((try paper_mutation_regression(
        alloc,
        id,
        "mcp_paper_write_html",
        "{\"html\":\"<div style='color: var(--fg-primary)'><x-paper-clone node-id='A-1' /></div>\"}",
        "Build the screen.",
        false,
    )) == null);
}

test "Design mode derives automatic checkpoint targets from Paper writes" {
    const alloc = std.testing.allocator;
    const html = (try automatic_check_arguments(
        alloc,
        id,
        "mcp_paper_write_html",
        "{\"fileId\":\"file-1\",\"targetNodeId\":\"node-1\",\"html\":\"<div />\",\"mode\":\"insert-children\"}",
    )).?;
    defer alloc.free(html);
    try std.testing.expectEqualStrings("{\"nodeId\":\"node-1\",\"fileId\":\"file-1\"}", html);

    const styles = (try automatic_check_arguments(
        alloc,
        id,
        "mcp_paper_update_styles",
        "{\"updates\":[{\"nodeIds\":[\"node-2\"],\"styles\":{\"gap\":\"var(--ds-flow-sm)\"}}]}",
    )).?;
    defer alloc.free(styles);
    try std.testing.expectEqualStrings("{\"nodeId\":\"node-2\"}", styles);
    try std.testing.expect(automatic_check_clean("{\"version\":1,\"status\":\"clean\",\"phase\":\"import\",\"capture_id\":\"capture-1\",\"artboard_id\":\"node-1\",\"source_revision\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"pending_verifications\":0,\"canvas_revision\":\"1111111111111111111111111111111111111111111111111111111111111111\"}"));
    try std.testing.expect(!automatic_check_clean("design-check: regression — 1 finding(s); confidence 9/10"));
}

test "Design completion requires a clean final verify after the latest Paper mutation" {
    var required = false;
    required = updateFinalVerificationRequired(required, id, "mcp_paper_write_html", true, "paper ok");
    try std.testing.expect(required);

    required = updateFinalVerificationRequired(required, id, "mcp_design_check", true, "{\"version\":1,\"status\":\"clean\",\"phase\":\"import\",\"capture_id\":\"capture-1\",\"artboard_id\":\"node-1\",\"source_revision\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"pending_verifications\":0,\"canvas_revision\":\"1111111111111111111111111111111111111111111111111111111111111111\"}");
    try std.testing.expect(required);

    required = updateFinalVerificationRequired(required, id, "mcp_fx_design_verify", true, "design-check: regression; confidence 9/10");
    try std.testing.expect(required);

    required = updateFinalVerificationRequired(required, id, "mcp_fx_design_verify", true, "{\"version\":1,\"status\":\"clean\",\"phase\":\"import\",\"capture_id\":\"capture-1\",\"artboard_id\":\"node-1\",\"source_revision\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"pending_verifications\":0,\"canvas_revision\":\"1111111111111111111111111111111111111111111111111111111111111111\"}");
    try std.testing.expect(!required);

    required = updateFinalVerificationRequired(required, id, "mcp_paper_update_styles", true, "paper ok");
    try std.testing.expect(required);

    required = updateFinalVerificationRequired(required, "code", "mcp_fx_design_verify", true, "{\"version\":1,\"status\":\"clean\",\"phase\":\"import\",\"capture_id\":\"capture-1\",\"artboard_id\":\"node-1\",\"source_revision\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"pending_verifications\":0,\"canvas_revision\":\"1111111111111111111111111111111111111111111111111111111111111111\"}");
    try std.testing.expect(required);
}

test "Design automatic whole-surface checkpoint satisfies the final gate" {
    const proof = "{\"version\":1,\"status\":\"clean\",\"phase\":\"import\",\"capture_id\":\"capture-1\",\"artboard_id\":\"node-1\",\"source_revision\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"pending_verifications\":0,\"canvas_revision\":\"1111111111111111111111111111111111111111111111111111111111111111\"}";
    try std.testing.expect(!updateFinalVerificationRequired(true, id, "mcp_fx_design_execute", true, "paper result\n\n[AUTOMATIC DESIGN CHECK]\n" ++ proof));
    try std.testing.expect(!updateFinalVerificationRequired(true, id, "mcp_fx_design_check", true, "{\"result\":{\"structuredContent\":" ++ proof ++ "}}"));
    try std.testing.expect(updateFinalVerificationRequired(false, id, "mcp_fx_design_prepare_import", true, "prepared"));
    try std.testing.expect(updateFinalVerificationRequired(false, id, "mcp_fx_design_execute", true, "paper result\n\n[AUTOMATIC DESIGN CHECK]\n{\"status\":\"pending\"}"));
}

test "Design mode derives mandatory project preflight arguments" {
    const alloc = std.testing.allocator;
    const arguments = (try automatic_preflight_arguments(
        alloc,
        id,
        "mcp_paper_write_html",
        "{\"targetNodeId\":\"node-1\",\"html\":\"<div />\"}",
    )).?;
    defer alloc.free(arguments);
    try std.testing.expect(std.mem.indexOf(u8, arguments, "mcp_paper_write_html") != null);
    try std.testing.expect(std.mem.indexOf(u8, arguments, "argumentsJson") != null);
    try std.testing.expect(automatic_preflight_clean("{\"version\":1,\"status\":\"clean\",\"capture_id\":\"capture-1\",\"source_revision\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"operation_hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}"));
    try std.testing.expect(!automatic_preflight_clean("design-preflight: blocked"));
}

pub const runtime_context =
    "Runtime context: interaction mode is design. Paper is the default canvas backend. Use the managed fx_design adapter, not a project-specific design MCP. " ++
    "Confirm the managed capture and execute tools are available before promising an import. If unavailable, stop the import and report the missing helper; do not repeatedly search, substitute shell browser scripts, hand-author a replacement, or advise restarting without evidence. Paper connectivity alone does not establish helper readiness. " ++
    "Discover mcp_fx_design_discover, mcp_fx_design_capture_source, mcp_fx_design_source_tree, mcp_fx_design_prepare_import, mcp_fx_design_execute, mcp_fx_design_inspect, mcp_fx_design_prepare_edit, mcp_fx_design_compare, mcp_fx_design_check and mcp_fx_design_verify through capability_search. fx supplies the active session directory. " ++
    "Read Paper's paper-mcp-instructions through get_guide, not resource_list or prompt_list. Discover the requested route including its shell, actual source assets, fonts, CSS imports and scoped tokens. Storybook is optional. " ++
    "Capture the live page, inspect the source tree, then prepare_import. Call execute with each pending operation hash; no separate selection of the underlying Paper tool is needed. fx loads the exact payload, checks permission, executes Paper and records its real result. Inspect after each action for the next operation. Never supply receipts or recreate an existing SVG or image from perception. " ++
    "Keep progress narration sparse: one initial update, then meaningful milestones or actionable blockers. Do not narrate every tool selection, discovery call, or retry. If the same verification blocker persists without new evidence, stop and report it once; never repeat mutations to repair receipts. " ++
    "Unsupported styling, ambiguous token bindings and missing fonts are findings, not permission to invent replacements. Verify the initial import before claiming fidelity. " ++
    "Once verified, intentional Paper edits are design changes, not regressions against the old screenshot. Layer names may change without changing source identity. Use prepare_edit for targeted canvas changes. " ++
    "On an explicit request to apply the design to code, compare current Paper and source against the baseline. Use normal file-edit tools for targeted changes to existing components, preserving handlers, accessibility and data flow. Resolve concurrent source edits first. " ++
    "Re-render and test affected interactions. Never claim code application is verified unless current code has been compared with the requested Paper design. " ++
    "Completion requires structured verification for the relevant capture and current artboard. Report unresolved findings honestly; confidence 10/10 is not evidence.";
