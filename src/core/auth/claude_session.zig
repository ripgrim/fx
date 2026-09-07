//! Delegated Claude subscription auth.
//!
//! fx never performs a Claude OAuth flow and never stores a Claude token. The
//! locally installed Claude Code binary owns the credential; fx only asks it
//! who is signed in via `claude auth status --json`.
//!
//! The probe also enforces the provider's hard constraint: fx routes to Claude
//! only through a first-party subscription. An `apiKey` auth method or a
//! Bedrock/Vertex provider is rejected rather than silently used, so this route
//! can never spend Anthropic API credits.

const std = @import("std");
const debug_trace = @import("../shared/debug_trace.zig");
const host_target = @import("../hosts/target.zig");
const io_mod = @import("../shared/io.zig");

const Allocator = std.mem.Allocator;

/// Claude Code prints a small fixed JSON object; this bounds a wedged or
/// misbehaving binary rather than reading unbounded output into memory.
const max_status_bytes: usize = 64 * 1024;
const probe_timeout: std.Io.Timeout = .{
    .duration = .{
        .raw = .{ .nanoseconds = 30 * std.time.ns_per_s },
        .clock = .awake,
    },
};
const max_identity_bytes: usize = 1024;

/// Auth method reported by Claude Code for a first-party subscription login.
const subscription_auth_method = "claude.ai";
/// Auth method reported when Claude Code is running on an Anthropic API key.
const api_key_auth_method = "apiKey";
/// API provider reported for direct Anthropic access (not Bedrock/Vertex).
const first_party_api_provider = "firstParty";

pub const Status = struct {
    logged_in: bool,
    auth_method: []u8,
    api_provider: ?[]u8 = null,
    email: ?[]u8 = null,
    org_id: ?[]u8 = null,
    org_name: ?[]u8 = null,
    subscription_type: ?[]u8 = null,

    pub fn deinit(self: *Status, alloc: Allocator) void {
        alloc.free(self.auth_method);
        if (self.api_provider) |value| alloc.free(value);
        if (self.email) |value| alloc.free(value);
        if (self.org_id) |value| alloc.free(value);
        if (self.org_name) |value| alloc.free(value);
        if (self.subscription_type) |value| alloc.free(value);
        self.* = undefined;
    }

    /// Stable per-account identity for the credential authority. Prefers the
    /// organization ID and falls back to the account email.
    pub fn accountId(self: Status) ?[]const u8 {
        if (self.org_id) |org_id| {
            if (validIdentity(org_id)) return org_id;
        }
        if (self.email) |email| {
            if (validIdentity(email)) return email;
        }
        return null;
    }

    /// True only for a first-party Claude subscription login. Anything else —
    /// an API key, Bedrock, or Vertex — is not a subscription route.
    pub fn isSubscription(self: Status) bool {
        if (!self.logged_in) return false;
        if (!std.mem.eql(u8, self.auth_method, subscription_auth_method)) return false;
        const api_provider = self.api_provider orelse return true;
        return std.mem.eql(u8, api_provider, first_party_api_provider);
    }

    pub fn usesApiKey(self: Status) bool {
        return std.mem.eql(u8, self.auth_method, api_key_auth_method);
    }
};

pub fn validIdentity(value: []const u8) bool {
    if (value.len == 0 or value.len > max_identity_bytes) return false;
    for (value) |byte| {
        if (byte < 0x21 or byte > 0x7e) return false;
    }
    return true;
}

/// Human-readable plan label for the auth status line, mirroring the wording
/// Claude Code and Anthropic use for each subscription tier.
pub fn subscriptionLabel(subscription_type: ?[]const u8) []const u8 {
    const raw = subscription_type orelse return "Claude subscription";
    if (std.ascii.eqlIgnoreCase(raw, "pro")) return "Claude Pro";
    if (std.ascii.eqlIgnoreCase(raw, "max")) return "Claude Max";
    if (std.ascii.eqlIgnoreCase(raw, "team")) return "Claude Team";
    if (std.ascii.eqlIgnoreCase(raw, "enterprise")) return "Claude Enterprise";
    if (std.ascii.eqlIgnoreCase(raw, "free")) return "Claude Free";
    return "Claude subscription";
}

fn dupeOptionalString(alloc: Allocator, object: std.json.ObjectMap, key: []const u8) !?[]u8 {
    const value = object.get(key) orelse return null;
    if (value != .string) return null;
    if (value.string.len == 0) return null;
    return try alloc.dupe(u8, value.string);
}

/// Pure parser for `claude auth status --json` output.
pub fn parseStatus(alloc: Allocator, body: []const u8) !Status {
    if (body.len > max_status_bytes) return error.InvalidClaudeAuthStatus;

    var parsed = std.json.parseFromSlice(std.json.Value, alloc, body, .{}) catch
        return error.InvalidClaudeAuthStatus;
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidClaudeAuthStatus;
    const object = parsed.value.object;

    const logged_in_value = object.get("loggedIn") orelse return error.InvalidClaudeAuthStatus;
    if (logged_in_value != .bool) return error.InvalidClaudeAuthStatus;

    const auth_method_value = object.get("authMethod");
    const auth_method_slice = if (auth_method_value) |value|
        (if (value == .string) value.string else return error.InvalidClaudeAuthStatus)
    else
        "";

    const auth_method = try alloc.dupe(u8, auth_method_slice);
    var status = Status{ .logged_in = logged_in_value.bool, .auth_method = auth_method };
    errdefer status.deinit(alloc);

    status.api_provider = try dupeOptionalString(alloc, object, "apiProvider");
    status.email = try dupeOptionalString(alloc, object, "email");
    status.org_id = try dupeOptionalString(alloc, object, "orgId");
    status.org_name = try dupeOptionalString(alloc, object, "orgName");
    status.subscription_type = try dupeOptionalString(alloc, object, "subscriptionType");
    return status;
}

/// Runs `claude auth status --json` against the resolved Claude Code binary.
/// Returns null when Claude Code is not installed, which callers surface as an
/// actionable setup message rather than an auth failure.
pub fn probe(alloc: Allocator, executable: []const u8) !?Status {
    if (comptime host_target.is_wasm) return null;

    const argv = [_][]const u8{ executable, "auth", "status", "--json" };
    const result = std.process.run(alloc, io_mod.getIo(), .{
        .argv = &argv,
        .stdout_limit = .limited(max_status_bytes),
        .stderr_limit = .limited(max_status_bytes),
        .timeout = probe_timeout,
    }) catch |err| switch (err) {
        error.FileNotFound => {
            debug_trace.logf("auth", "Claude auth probe skipped step=missing_binary", .{});
            return null;
        },
        else => {
            debug_trace.logf("auth", "Claude auth probe failed step=spawn err={s}", .{@errorName(err)});
            return error.ClaudeCodeProbeFailed;
        },
    };
    defer alloc.free(result.stdout);
    defer alloc.free(result.stderr);

    // A logged-out Claude Code still prints `{"loggedIn":false}` and may exit
    // nonzero, so parse first and only treat unparseable output as a failure.
    return parseStatus(alloc, std.mem.trim(u8, result.stdout, " \t\r\n")) catch |err| {
        debug_trace.logf(
            "auth",
            "Claude auth probe failed step=parse err={s} exit={d}",
            .{ @errorName(err), result.term.exited },
        );
        return error.ClaudeCodeProbeFailed;
    };
}

test "parse status reads a first-party subscription login" {
    const body =
        \\{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
        \\ "email":"person@example.com","orgId":"org-123","orgName":"Example",
        \\ "subscriptionType":"team"}
    ;
    var status = try parseStatus(std.testing.allocator, body);
    defer status.deinit(std.testing.allocator);

    try std.testing.expect(status.logged_in);
    try std.testing.expect(status.isSubscription());
    try std.testing.expect(!status.usesApiKey());
    try std.testing.expectEqualStrings("org-123", status.accountId().?);
    try std.testing.expectEqualStrings("Claude Team", subscriptionLabel(status.subscription_type));
}

test "api key logins are never treated as a subscription route" {
    const body =
        \\{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}
    ;
    var status = try parseStatus(std.testing.allocator, body);
    defer status.deinit(std.testing.allocator);

    try std.testing.expect(status.logged_in);
    try std.testing.expect(status.usesApiKey());
    try std.testing.expect(!status.isSubscription());
}

test "bedrock and vertex logins are not subscription routes" {
    for ([_][]const u8{ "bedrock", "vertex" }) |provider| {
        const body = try std.fmt.allocPrint(
            std.testing.allocator,
            "{{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"{s}\"}}",
            .{provider},
        );
        defer std.testing.allocator.free(body);

        var status = try parseStatus(std.testing.allocator, body);
        defer status.deinit(std.testing.allocator);
        try std.testing.expect(!status.isSubscription());
    }
}

test "logged out status is not a subscription route" {
    var status = try parseStatus(std.testing.allocator, "{\"loggedIn\":false}");
    defer status.deinit(std.testing.allocator);

    try std.testing.expect(!status.logged_in);
    try std.testing.expect(!status.isSubscription());
    try std.testing.expect(status.accountId() == null);
}

test "account identity falls back to email when no organization is present" {
    const body =
        \\{"loggedIn":true,"authMethod":"claude.ai","email":"person@example.com"}
    ;
    var status = try parseStatus(std.testing.allocator, body);
    defer status.deinit(std.testing.allocator);

    try std.testing.expectEqualStrings("person@example.com", status.accountId().?);
}

test "malformed status output is rejected" {
    try std.testing.expectError(
        error.InvalidClaudeAuthStatus,
        parseStatus(std.testing.allocator, "not json"),
    );
    try std.testing.expectError(
        error.InvalidClaudeAuthStatus,
        parseStatus(std.testing.allocator, "[]"),
    );
    try std.testing.expectError(
        error.InvalidClaudeAuthStatus,
        parseStatus(std.testing.allocator, "{\"authMethod\":\"claude.ai\"}"),
    );
}

test "subscription labels cover the documented plan tiers" {
    try std.testing.expectEqualStrings("Claude Pro", subscriptionLabel("pro"));
    try std.testing.expectEqualStrings("Claude Max", subscriptionLabel("Max"));
    try std.testing.expectEqualStrings("Claude Enterprise", subscriptionLabel("enterprise"));
    try std.testing.expectEqualStrings("Claude subscription", subscriptionLabel(null));
    try std.testing.expectEqualStrings("Claude subscription", subscriptionLabel("unknown-tier"));
}
