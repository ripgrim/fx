//! Claude subscription model catalog.
//!
//! Claude Code exposes no catalog endpoint, so unlike the Codex and Grok routes
//! there is nothing to fetch: this is a static list of the models `claude
//! --model` accepts. Claude Code validates the selection against the signed-in
//! subscription at turn time and reports an actionable error itself, so fx
//! deliberately advertises the full set rather than guessing entitlements.

const std = @import("std");
const model_catalog = @import("../core/gateway/model_catalog.zig");
const gateway_provider = @import("../core/gateway/gateway_provider.zig");

const Allocator = std.mem.Allocator;

/// One catalog row. `released` only orders the list; larger sorts first.
const Entry = struct {
    id: []const u8,
    released: i64,
    context_window: u32,
    max_tokens: u32,
    has_vision: bool = true,
    has_reasoning: bool = true,
};

const entries = [_]Entry{
    .{ .id = "claude-opus-5", .released = 90, .context_window = 1_000_000, .max_tokens = 128_000 },
    .{ .id = "claude-fable-5", .released = 85, .context_window = 1_000_000, .max_tokens = 128_000 },
    .{ .id = "claude-sonnet-5", .released = 80, .context_window = 1_000_000, .max_tokens = 128_000 },
    .{ .id = "claude-opus-4-8", .released = 70, .context_window = 1_000_000, .max_tokens = 128_000 },
    .{ .id = "claude-sonnet-4-6", .released = 60, .context_window = 1_000_000, .max_tokens = 128_000 },
    .{ .id = "claude-haiku-4-5", .released = 50, .context_window = 200_000, .max_tokens = 64_000 },
};

pub const model_catalog_provider = model_catalog.Provider{
    .fetch_fn = fetchCatalogForProvider,
};

pub const cli_model_catalog_provider = gateway_provider.CliModelCatalogProvider{
    .fetch_fn = fetchCliModelCatalog,
};

/// True when `id` is a model fx advertises for the Claude route. Callers use
/// this to reject a stale `claude_model` setting before spawning Claude Code.
pub fn isKnownModel(id: []const u8) bool {
    for (&entries) |entry| {
        if (std.mem.eql(u8, entry.id, id)) return true;
    }
    return false;
}

/// Model fx selects when the Claude route is chosen without an explicit model.
pub fn defaultModel() []const u8 {
    return entries[0].id;
}

fn buildCatalog(alloc: Allocator) Allocator.Error!std.ArrayList(model_catalog.ModelCatalogEntry) {
    var catalog: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
    errdefer model_catalog.freeModelCatalog(alloc, &catalog);

    try catalog.ensureTotalCapacityPrecise(alloc, entries.len);
    for (&entries) |entry| {
        const id = try alloc.dupe(u8, entry.id);
        errdefer alloc.free(id);
        const model_type = try alloc.dupe(u8, "language");
        errdefer alloc.free(model_type);

        catalog.appendAssumeCapacity(.{
            .id = id,
            .model_type = model_type,
            .released = entry.released,
            .has_tool_use = true,
            .has_reasoning = entry.has_reasoning,
            .has_vision = entry.has_vision,
            .has_file_input = true,
            .has_implicit_caching = true,
            .context_window = entry.context_window,
            .max_tokens = entry.max_tokens,
        });
    }
    return catalog;
}

fn fetchCatalogForProvider(
    _: ?*anyopaque,
    alloc: Allocator,
    _: model_catalog.FetchInput,
) Allocator.Error!model_catalog.ProviderResult {
    return .{ .catalog = try buildCatalog(alloc) };
}

fn fetchCliModelCatalog(
    _: ?*anyopaque,
    alloc: Allocator,
    input: gateway_provider.CliModelCatalogInput,
) gateway_provider.CliModelCatalogResult {
    return switch (model_catalog.fetchWithPublicFallback(model_catalog_provider, alloc, .{
        .access = input.access,
        .endpoint = input.endpoint,
        .cancel_flag = input.cancel_flag,
        .view = .full,
    })) {
        .loaded => |loaded| blk: {
            var catalog = loaded.catalog;
            defer model_catalog.freeModelCatalog(alloc, &catalog);
            const ids = model_catalog.projectModelIds(alloc, catalog.items) catch break :blk .{ .failure = .{
                .access = loaded.provenance.access,
                .anonymous_fallback_used = false,
                .failure = .{ .category = .resource_exhausted },
            } };
            break :blk .{ .loaded = .{
                .ids = ids,
                .provenance = loaded.provenance,
            } };
        },
        .failed => |failure| .{ .failure = failure },
    };
}

test "claude catalog advertises every subscription model" {
    var result = try model_catalog_provider.fetch(std.testing.allocator, .{ .endpoint = "" });
    switch (result) {
        .catalog => |*catalog| {
            var owned = catalog.*;
            defer model_catalog.freeModelCatalog(std.testing.allocator, &owned);
            try std.testing.expectEqual(entries.len, owned.items.len);
            try std.testing.expectEqualStrings("claude-opus-5", owned.items[0].id);
            try std.testing.expectEqualStrings("language", owned.items[0].model_type);
            try std.testing.expect(owned.items[0].has_tool_use);
            try std.testing.expectEqual(@as(u32, 1_000_000), owned.items[0].context_window);
        },
        .failure => return error.TestUnexpectedResult,
    }
}

test "haiku carries its smaller context and output ceiling" {
    var result = try model_catalog_provider.fetch(std.testing.allocator, .{ .endpoint = "" });
    switch (result) {
        .catalog => |*catalog| {
            var owned = catalog.*;
            defer model_catalog.freeModelCatalog(std.testing.allocator, &owned);
            const haiku = for (owned.items) |item| {
                if (std.mem.eql(u8, item.id, "claude-haiku-4-5")) break item;
            } else return error.TestUnexpectedResult;
            try std.testing.expectEqual(@as(u32, 200_000), haiku.context_window);
            try std.testing.expectEqual(@as(u32, 64_000), haiku.max_tokens);
        },
        .failure => return error.TestUnexpectedResult,
    }
}

test "known model lookup covers the advertised ids and rejects others" {
    try std.testing.expect(isKnownModel("claude-opus-5"));
    try std.testing.expect(isKnownModel("claude-haiku-4-5"));
    try std.testing.expect(!isKnownModel("claude-opus-4-5"));
    try std.testing.expect(!isKnownModel("opus"));
    try std.testing.expect(!isKnownModel(""));
    try std.testing.expectEqualStrings("claude-opus-5", defaultModel());
}
