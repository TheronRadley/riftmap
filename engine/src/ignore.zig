//! Directory / file exclusion rules.
//!
//! Three layers, applied in order:
//!
//! 1. A built-in deny list of build output, dependency and cache directories,
//!    lockfiles and binary asset extensions.
//! 2. Repository ignore files at the *root* only: `.gitignore` and
//!    `.riftmapignore`. Nested ignore files are not applied - this is an
//!    explicit, documented limitation of the MVP scanner.
//! 3. Extra patterns supplied with `--ignore`.
//!
//! Pattern syntax is a deliberately small subset of gitignore: a literal path
//! segment match, an optional leading `/` to anchor at the repository root, an
//! optional trailing `/` to match directories only, a leading `!` to negate,
//! and a single `*` wildcard. Full gitignore semantics (character classes,
//! `**` anchoring rules, nested precedence) are *not* implemented.

const std = @import("std");

pub const BUILTIN_DIRS = [_][]const u8{
    ".git", ".hg", ".svn", ".bzr",
    "node_modules", "bower_components", "jspm_packages", "web_modules",
    "vendor", "third_party", "third-party", "site-packages",
    "dist", "build", "out", "target", "bin", "obj", "release", "debug",
    "coverage", ".nyc_output", "htmlcov",
    ".next", ".nuxt", ".output", ".svelte-kit", ".docusaurus", ".vitepress",
    ".turbo", ".cache", ".parcel-cache", ".vite", ".yarn", ".pnpm-store",
    ".serverless", ".fusebox", ".dynamodb", ".terraform", ".gradle",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox",
    ".eggs", ".venv", "venv", "env", ".bundle",
    "zig-out", "zig-cache", ".zig-cache",
    "Pods", "DerivedData", "Carthage",
    ".idea", ".vscode", ".fleet",
    "tmp", "temp", "logs",
};

pub const BUILTIN_FILES = [_][]const u8{
    ".DS_Store", "Thumbs.db", "desktop.ini",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
    "poetry.lock", "Pipfile.lock", "Cargo.lock", "composer.lock",
    "go.sum", "flake.lock", "Gemfile.lock", "bun.lockb",
};

/// File-name suffixes that never contribute useful signal (generated bundles).
pub const BUILTIN_NAME_SUFFIXES = [_][]const u8{
    ".min.js", ".min.css", ".bundle.js", ".bundle.css", ".generated.ts",
    ".designer.cs", ".g.dart", ".pb.go", ".d.ts.map",
};

pub const BUILTIN_EXTS = [_][]const u8{
    // images
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "tiff", "psd", "heic",
    // fonts
    "woff", "woff2", "ttf", "eot", "otf",
    // media
    "mp3", "mp4", "wav", "ogg", "avi", "mov", "mkv", "webm", "flac",
    // archives and binaries
    "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war",
    "class", "o", "a", "so", "dylib", "dll", "exe", "bin", "wasm", "node",
    // data / generated
    "pyc", "pyo", "pyd", "map", "dat", "db", "sqlite", "sqlite3", "pdf",
};

const Pattern = struct {
    negate: bool,
    dir_only: bool,
    anchored: bool,
    parts: [][]const u8,
};

pub const IgnoreRules = struct {
    dirs: std.StringHashMap(void),
    files: std.StringHashMap(void),
    exts: std.StringHashMap(void),
    patterns: std.ArrayList(Pattern),
    pattern_storage: std.ArrayList([]const u8),
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) !IgnoreRules {
        var self = IgnoreRules{
            .dirs = std.StringHashMap(void).init(allocator),
            .files = std.StringHashMap(void).init(allocator),
            .exts = std.StringHashMap(void).init(allocator),
            .patterns = std.ArrayList(Pattern).init(allocator),
            .pattern_storage = std.ArrayList([]const u8).init(allocator),
            .allocator = allocator,
        };
        for (BUILTIN_DIRS) |d| try self.dirs.put(d, {});
        for (BUILTIN_FILES) |f| try self.files.put(f, {});
        for (BUILTIN_EXTS) |e| try self.exts.put(e, {});
        return self;
    }

    pub fn deinit(self: *IgnoreRules) void {
        self.dirs.deinit();
        self.files.deinit();
        self.exts.deinit();
        for (self.pattern_storage.items) |s| self.allocator.free(s);
        self.pattern_storage.deinit();
        for (self.patterns.items) |p| self.allocator.free(p.parts);
        self.patterns.deinit();
    }

    pub fn addPattern(self: *IgnoreRules, line: []const u8) !void {
        var text = std.mem.trim(u8, line, " \t\r\n");
        if (text.len == 0 or std.mem.startsWith(u8, text, "#")) return;
        var negate = false;
        if (text[0] == '!') {
            negate = true;
            text = text[1..];
        }
        var anchored = false;
        if (text.len > 0 and text[0] == '/') {
            anchored = true;
            text = text[1..];
        }
        var dir_only = false;
        if (text.len > 0 and text[text.len - 1] == '/') {
            dir_only = true;
            text = text[0 .. text.len - 1];
        }
        if (text.len == 0) return;
        const owned = try self.allocator.dupe(u8, text);
        try self.pattern_storage.append(owned);
        var parts = std.ArrayList([]const u8).init(self.allocator);
        var it = std.mem.splitScalar(u8, owned, '*');
        while (it.next()) |p| try parts.append(p);
        try self.patterns.append(.{
            .negate = negate,
            .dir_only = dir_only,
            .anchored = anchored,
            .parts = try parts.toOwnedSlice(),
        });
    }

    /// Add every line of `text` as a pattern.
    pub fn addPatternsFromText(self: *IgnoreRules, text: []const u8) !void {
        var it = std.mem.splitScalar(u8, text, '\n');
        while (it.next()) |line| try self.addPattern(line);
    }

    /// Load `.gitignore` and `.riftmapignore` from the repository root.
    pub fn loadRepoIgnoreFiles(self: *IgnoreRules, dir: std.fs.Dir) !void {
        for ([_][]const u8{ ".riftmapignore", ".gitignore" }) |name| {
            const data = dir.readFileAlloc(self.allocator, name, 1024 * 1024) catch continue;
            defer self.allocator.free(data);
            try self.addPatternsFromText(data);
        }
    }

    pub fn isIgnoredDir(self: *const IgnoreRules, name: []const u8, rel_path: []const u8) bool {
        if (self.dirs.contains(name)) return true;
        return self.matchPatterns(rel_path, true);
    }

    pub fn isIgnoredFile(self: *const IgnoreRules, name: []const u8, rel_path: []const u8) bool {
        if (self.files.contains(name)) return true;
        if (self.exts.contains(extOf(name))) return true;
        for (BUILTIN_NAME_SUFFIXES) |suffix| {
            if (std.mem.endsWith(u8, name, suffix)) return true;
        }
        return self.matchPatterns(rel_path, false);
    }

    /// Later patterns win over earlier ones, so `!negated` rules can un-ignore.
    fn matchPatterns(self: *const IgnoreRules, rel_path: []const u8, is_dir: bool) bool {
        var ignored = false;
        for (self.patterns.items) |p| {
            if (p.dir_only and !is_dir) continue;
            if (matchPattern(p, rel_path)) ignored = !p.negate;
        }
        return ignored;
    }
};

fn matchPattern(p: Pattern, rel_path: []const u8) bool {
    if (p.anchored) {
        return matchWildcard(p.parts, rel_path, true);
    }

    // Unanchored: match against the whole path or any trailing segment.
    if (matchWildcard(p.parts, rel_path, false)) return true;
    // Check every suffix that starts at a segment boundary.
    var i: usize = 0;
    while (i <= rel_path.len) : (i += 1) {
        if (i > 0 and rel_path[i - 1] != '/') continue;
        if (matchWildcard(p.parts, rel_path[i..], false)) return true;
    }
    return false;
}

fn matchWildcard(parts: [][]const u8, text: []const u8, anchored: bool) bool {
    if (parts.len == 1) {
        if (anchored) return std.mem.eql(u8, parts[0], text);
        // A single literal part matches a full segment or a trailing path.
        if (std.mem.eql(u8, parts[0], text)) return true;
        if (std.mem.endsWith(u8, text, parts[0]) and text.len > parts[0].len and text[text.len - parts[0].len - 1] == '/') return true;
        return false;
    }
    var pos: usize = 0;
    for (parts, 0..) |part, idx| {
        if (part.len == 0) continue;
        if (idx == 0) {
            if (anchored) {
                if (!std.mem.startsWith(u8, text, part)) return false;
                pos = part.len;
                continue;
            }
            if (!std.mem.startsWith(u8, text, part)) return false;
            pos = part.len;
            continue;
        }
        if (idx == parts.len - 1) {
            if (!std.mem.endsWith(u8, text[pos..], part)) return false;
            return text.len >= pos + part.len;
        }
        const found = std.mem.indexOf(u8, text[pos..], part) orelse return false;
        pos += found + part.len;
    }
    return true;
}

pub fn extOf(name: []const u8) []const u8 {
    const base = std.fs.path.basename(name);
    const dot = std.mem.lastIndexOfScalar(u8, base, '.') orelse return "";
    if (dot == 0) return "";
    return base[dot + 1 ..];
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test "builtin deny list covers dependency and build directories" {
    var rules = try IgnoreRules.init(std.testing.allocator);
    defer rules.deinit();
    try std.testing.expect(rules.isIgnoredDir("node_modules", "node_modules"));
    try std.testing.expect(rules.isIgnoredDir("node_modules", "packages/a/node_modules"));
    try std.testing.expect(rules.isIgnoredDir(".git", ".git"));
    try std.testing.expect(rules.isIgnoredDir("dist", "apps/desktop/dist"));
    try std.testing.expect(!rules.isIgnoredDir("src", "src"));
    try std.testing.expect(!rules.isIgnoredDir("engine", "engine"));
}

test "lockfiles and binary assets are ignored" {
    var rules = try IgnoreRules.init(std.testing.allocator);
    defer rules.deinit();
    try std.testing.expect(rules.isIgnoredFile("package-lock.json", "package-lock.json"));
    try std.testing.expect(rules.isIgnoredFile("logo.png", "assets/logo.png"));
    try std.testing.expect(rules.isIgnoredFile("app.min.js", "dist/app.min.js"));
    try std.testing.expect(!rules.isIgnoredFile("main.ts", "src/main.ts"));
}

test "gitignore style patterns" {
    var rules = try IgnoreRules.init(std.testing.allocator);
    defer rules.deinit();
    try rules.addPatternsFromText(
        \\# a comment
        \\
        \\*.log
        \\/scratch
        \\generated/
        \\
    );
    try std.testing.expect(rules.isIgnoredFile("server.log", "logs/server.log"));
    try std.testing.expect(!rules.isIgnoredFile("server.ts", "src/server.ts"));
    try std.testing.expect(rules.isIgnoredDir("scratch", "scratch"));
    try std.testing.expect(!rules.isIgnoredDir("scratch", "src/scratch"));
    // `tmp` is part of the built-in deny list, so it is ignored anywhere.
    try std.testing.expect(rules.isIgnoredDir("tmp", "src/tmp"));
    try std.testing.expect(rules.isIgnoredDir("generated", "src/generated"));
    try std.testing.expect(!rules.isIgnoredFile("a.txt", "src/generated/a.txt"));
}

test "negated patterns un-ignore" {
    var rules = try IgnoreRules.init(std.testing.allocator);
    defer rules.deinit();
    try rules.addPatternsFromText("*.log\n!keep.log\n");
    try std.testing.expect(rules.isIgnoredFile("a.log", "a.log"));
    try std.testing.expect(!rules.isIgnoredFile("keep.log", "keep.log"));
}

test "extension helper" {
    try std.testing.expectEqualStrings("ts", extOf("main.ts"));
    try std.testing.expectEqualStrings("ts", extOf("a/b/main.ts"));
    try std.testing.expectEqualStrings("", extOf("Makefile"));
    try std.testing.expectEqualStrings("", extOf(".gitignore"));
    try std.testing.expectEqualStrings("json", extOf("archive.tar.json"));
}
