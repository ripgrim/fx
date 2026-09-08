const std = @import("std");
const types = @import("../shared/types.zig");

pub const ProviderId = enum {
    gateway,
    codex,
    grok,
    claude,
};

pub const ProviderSelection = struct {
    provider: ProviderId,
    model: []const u8,
};

pub fn parse(value: []const u8) ?ProviderId {
    if (std.ascii.eqlIgnoreCase(value, "gateway")) return .gateway;
    if (std.ascii.eqlIgnoreCase(value, "codex")) return .codex;
    if (std.ascii.eqlIgnoreCase(value, "grok")) return .grok;
    if (std.ascii.eqlIgnoreCase(value, "claude")) return .claude;
    return null;
}

pub fn authorizesCredential(provider: ProviderId, source: ?types.CredentialSource) bool {
    const selected = source orelse return false;
    return switch (provider) {
        .gateway => selected != .chatgpt_subscription and
            selected != .grok_subscription and
            selected != .claude_subscription,
        .codex => selected == .chatgpt_subscription,
        .grok => selected == .grok_subscription,
        .claude => selected == .claude_subscription,
    };
}

test "explicit providers authorize only their own credential origins" {
    try std.testing.expect(authorizesCredential(.gateway, .ai_gateway_api_key));
    try std.testing.expect(authorizesCredential(.gateway, .fx_login));
    try std.testing.expect(!authorizesCredential(.gateway, .chatgpt_subscription));
    try std.testing.expect(authorizesCredential(.codex, .chatgpt_subscription));
    try std.testing.expect(!authorizesCredential(.codex, .ai_gateway_api_key));
    try std.testing.expect(!authorizesCredential(.codex, null));
    try std.testing.expect(authorizesCredential(.grok, .grok_subscription));
    try std.testing.expect(!authorizesCredential(.grok, .chatgpt_subscription));
    try std.testing.expect(!authorizesCredential(.gateway, .grok_subscription));
    try std.testing.expect(authorizesCredential(.claude, .claude_subscription));
    try std.testing.expect(!authorizesCredential(.claude, .chatgpt_subscription));
    try std.testing.expect(!authorizesCredential(.claude, .ai_gateway_api_key));
    try std.testing.expect(!authorizesCredential(.claude, null));
    try std.testing.expect(!authorizesCredential(.gateway, .claude_subscription));
}

test "provider parsing exposes gateway codex grok and claude" {
    try std.testing.expectEqual(ProviderId.gateway, parse("gateway").?);
    try std.testing.expectEqual(ProviderId.codex, parse("CODEX").?);
    try std.testing.expectEqual(ProviderId.grok, parse("GROK").?);
    try std.testing.expectEqual(ProviderId.claude, parse("Claude").?);
    try std.testing.expect(parse("openai-codex") == null);
    try std.testing.expect(parse("anthropic") == null);
    try std.testing.expect(parse("") == null);
}
