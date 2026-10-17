//! riftmap-engine - the native analysis engine behind Riftmap.
//!
//! The engine is a standalone command line tool. It knows nothing about
//! Electron: it reads a repository path, writes a versioned JSON document on
//! standard output and reports diagnostics on standard error.
//!
//! Exit codes:
//!   0  analysis completed (possibly with per-file warnings)
//!   1  usage error
//!   2  fatal error (root missing, output unwritable, ...)
//!   3  analysis completed but the scan was truncated by a safety limit

const std = @import("std");
const analyze = @import("analyze.zig");
const json_output = @import("json_output.zig");

const EXIT_OK: u8 = 0;
const EXIT_USAGE: u8 = 1;
const EXIT_FATAL: u8 = 2;
const EXIT_TRUNCATED: u8 = 3;

const USAGE =
    \\riftmap-engine - native repository analysis engine for Riftmap
    \\
    \\USAGE:
    \\  riftmap-engine [options] <repository-path>
    \\  riftmap-engine --version
    \\  riftmap-engine --schema
    \\  riftmap-engine --help
    \\
    \\OUTPUT:
    \\  A versioned JSON document is written to standard output (or to the file
    \\  given with --out). Progress events and diagnostics are written to
    \\  standard error and never contaminate the JSON stream.
    \\
    \\OPTIONS:
    \\  --out <file>             Write JSON to <file> instead of stdout
    \\  --pretty                 Pretty-print the JSON (indent 2)
    \\  --progress               Emit progress events as JSON lines on stderr
    \\  --max-file-bytes <n>     Skip content analysis above <n> bytes (default 8 MiB)
    \\  --max-files <n>          Stop after <n> tracked files (default 200000)
    \\  --max-depth <n>          Maximum directory depth (default 64)
    \\  --max-total-bytes <n>    Stop after <n> bytes of source (default 4 GiB)
    \\  --large-file-mode <mode> skip | count-lines | full   (default count-lines)
    \\  --ignore <pattern>       Additional ignore pattern (repeatable)
    \\  --no-gitignore           Do not read .gitignore / .riftmapignore
    \\  --include-hidden         Include dot-files and dot-directories
    \\  --no-imports             Skip import extraction
    \\  --no-complexity          Skip lexical complexity analysis
    \\  --help                   Show this message
    \\
    \\EXIT CODES:
    \\  0 success   1 usage   2 fatal   3 completed but truncated
    \\
;

pub fn main() u8 {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();
    const stderr = std.io.getStdErr();

    const args = std.process.argsAlloc(allocator) catch {
        stderr.writeAll("{\"type\":\"fatal\",\"code\":\"argv\",\"message\":\"could not read arguments\"}\n") catch {};
        return EXIT_FATAL;
    };
    defer std.process.argsFree(allocator, args);

    return runCli(allocator, args[1..], std.io.getStdOut(), stderr);
}

fn runCli(allocator: std.mem.Allocator, argv: [][:0]u8, stdout: std.fs.File, stderr: std.fs.File) u8 {
    var root: ?[]const u8 = null;
    var out_path: ?[]const u8 = null;
    var pretty = false;
    var want_progress = false;
    var opts = analyze.Options{ .root = "" };
    var ignore_list = std.ArrayList([]const u8).init(allocator);
    defer ignore_list.deinit();

    var i: usize = 0;
    while (i < argv.len) : (i += 1) {
        const arg = argv[i];

        if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            stdout.writeAll(USAGE) catch {};
            return EXIT_OK;
        }
        if (std.mem.eql(u8, arg, "--version")) {
            stdout.writer().print("riftmap-engine {s} (zig {s}, schema {d})\n", .{ json_output.build.version, builtin_zig_version(), analyze.SCHEMA_VERSION }) catch {};
            return EXIT_OK;
        }
        if (std.mem.eql(u8, arg, "--schema")) {
            stdout.writeAll(SCHEMA_TEXT) catch {};
            return EXIT_OK;
        }
        if (std.mem.eql(u8, arg, "--pretty")) {
            pretty = true;
            continue;
        }
        if (std.mem.eql(u8, arg, "--progress")) {
            want_progress = true;
            continue;
        }
        if (std.mem.eql(u8, arg, "--no-gitignore")) {
            opts.use_gitignore = false;
            continue;
        }
        if (std.mem.eql(u8, arg, "--include-hidden")) {
            opts.include_hidden = true;
            continue;
        }
        if (std.mem.eql(u8, arg, "--no-imports")) {
            opts.extract_imports = false;
            continue;
        }
        if (std.mem.eql(u8, arg, "--no-complexity")) {
            opts.compute_complexity = false;
            continue;
        }

        // Anything that is not an option is the repository path.
        if (arg.len == 0 or arg[0] != '-') {
            if (root != null) {
                stderr.writeAll("error: only one repository path may be given\n") catch {};
                return EXIT_USAGE;
            }
            root = arg;
            continue;
        }

        const value = nextArg(argv, &i) catch {
            stderr.writer().print("error: {s} requires a value\n", .{arg}) catch {};
            return EXIT_USAGE;
        };
        if (std.mem.eql(u8, arg, "--out")) {
            out_path = value;
        } else if (std.mem.eql(u8, arg, "--max-file-bytes")) {
            opts.max_file_bytes = parseU64(value) orelse {
                stderr.writeAll("error: --max-file-bytes expects an integer\n") catch {};
                return EXIT_USAGE;
            };
        } else if (std.mem.eql(u8, arg, "--max-files")) {
            opts.max_files = parseInt(value) orelse {
                stderr.writeAll("error: --max-files expects an integer\n") catch {};
                return EXIT_USAGE;
            };
        } else if (std.mem.eql(u8, arg, "--max-depth")) {
            opts.max_depth = parseInt(value) orelse {
                stderr.writeAll("error: --max-depth expects an integer\n") catch {};
                return EXIT_USAGE;
            };
        } else if (std.mem.eql(u8, arg, "--max-total-bytes")) {
            opts.max_total_bytes = parseU64(value) orelse {
                stderr.writeAll("error: --max-total-bytes expects an integer\n") catch {};
                return EXIT_USAGE;
            };
        } else if (std.mem.eql(u8, arg, "--large-file-mode")) {
            opts.large_file_mode = if (std.mem.eql(u8, value, "skip"))
                .skip
            else if (std.mem.eql(u8, value, "count-lines"))
                .count_lines
            else if (std.mem.eql(u8, value, "full"))
                .full
            else {
                stderr.writeAll("error: --large-file-mode expects skip|count-lines|full\n") catch {};
                return EXIT_USAGE;
            };
        } else if (std.mem.eql(u8, arg, "--ignore")) {
            ignore_list.append(value) catch return EXIT_FATAL;
        } else {
            stderr.writer().print("error: unknown option {s}\n", .{arg}) catch {};
            return EXIT_USAGE;
        }
    }

    const root_path = root orelse {
        stderr.writeAll("error: no repository path given (try --help)\n") catch {};
        return EXIT_USAGE;
    };

    opts.root = root_path;
    opts.extra_ignore = ignore_list.items;

    var progress: ?analyze.Progress = null;
    if (want_progress) progress = analyze.Progress.init(stderr);

    var result = analyze.analyze(allocator, .{
        .root = opts.root,
        .max_file_bytes = opts.max_file_bytes,
        .large_file_mode = opts.large_file_mode,
        .max_files = opts.max_files,
        .max_depth = opts.max_depth,
        .max_total_bytes = opts.max_total_bytes,
        .include_hidden = opts.include_hidden,
        .use_gitignore = opts.use_gitignore,
        .extra_ignore = opts.extra_ignore,
        .extract_imports = opts.extract_imports,
        .compute_complexity = opts.compute_complexity,
        .progress = if (progress) |*p| p else null,
    }) catch |err| {
        const code = switch (err) {
            error.OutOfMemory => "out-of-memory",
            error.RootNotFound => "root-not-found",
            error.RootNotDirectory => "root-not-directory",
            error.RootAccessDenied => "root-access-denied",
        };
        stderr.writer().print("{{\"type\":\"fatal\",\"code\":\"{s}\",\"message\":\"{s}\"}}\n", .{ code, @errorName(err) }) catch {};
        return EXIT_FATAL;
    };
    defer result.deinit();

    var doc = json_output.buildDocument(allocator, &result, opts, builtin_zig_version()) catch {
        stderr.writeAll("{\"type\":\"fatal\",\"code\":\"serialize\",\"message\":\"could not build output document\"}\n") catch {};
        return EXIT_FATAL;
    };
    defer json_output.freeDocument(allocator, &doc);

    const write_result = blk: {
        if (out_path) |p| {
            const file = std.fs.cwd().createFile(p, .{ .truncate = true }) catch break :blk false;
            var bw = std.io.bufferedWriter(file.writer());
            json_output.writeDocument(&doc, bw.writer(), pretty) catch {
                file.close();
                break :blk false;
            };
            bw.flush() catch {
                file.close();
                break :blk false;
            };
            file.close();
            break :blk true;
        }
        var bw = std.io.bufferedWriter(stdout.writer());
        json_output.writeDocument(&doc, bw.writer(), pretty) catch break :blk false;
        bw.flush() catch break :blk false;
        if (pretty) {
            bw.writer().writeByte('\n') catch {};
            bw.flush() catch {};
        }
        break :blk true;
    };

    if (!write_result) {
        stderr.writeAll("{\"type\":\"fatal\",\"code\":\"write\",\"message\":\"could not write output\"}\n") catch {};
        return EXIT_FATAL;
    }

    stderr.writer().print("{{\"type\":\"done\",\"files\":{d},\"edges\":{d},\"elapsedMs\":{d},\"truncated\":{s}}}\n", .{
        result.summary.file_count,
        result.summary.edge_count,
        result.summary.elapsed_ms,
        if (result.summary.truncated) "true" else "false",
    }) catch {};

    return if (result.summary.truncated) EXIT_TRUNCATED else EXIT_OK;
}

fn nextArg(argv: [][:0]u8, i: *usize) ![]const u8 {
    if (i.* + 1 >= argv.len) return error.MissingValue;
    i.* += 1;
    return argv[i.*];
}

fn parseU64(s: []const u8) ?u64 {
    return std.fmt.parseInt(u64, s, 10) catch null;
}

fn parseInt(s: []const u8) ?usize {
    return std.fmt.parseInt(usize, s, 10) catch null;
}

pub fn builtin_zig_version() []const u8 {
    const v = @import("builtin").zig_version;
    return std.fmt.comptimePrint("{d}.{d}.{d}", .{ v.major, v.minor, v.patch });
}

const SCHEMA_TEXT =
    \\riftmap-engine JSON schema (schemaVersion = 2)
    \\
    \\{
    \\  "schemaVersion": 2,
    \\  "engine":  { "name", "version", "zigVersion", "buildMode" },
    \\  "scan":    { "root", "startedAtMs", "durationMs", "options", "limitations" },
    \\  "summary": {
    \\    "fileCount", "directoryCount", "totalBytes", "totalLines",
    \\    "codeLines", "blankLines", "commentLines", "languageCount",
    \\    "edgeCount", "resolvedEdgeCount", "externalEdgeCount", "unresolvedEdgeCount",
    \\    "filesWithComplexity", "filesWithImports",
    \\    "filesSkippedLarge", "filesSkippedIgnored", "filesSkippedUnreadable",
    \\    "filesSkippedUnsupported", "filesSkippedInvalidName",
    \\    "directoriesSkipped", "symlinksSkipped", "truncated", "elapsedMs"
    \\  },
    \\  "languages":   [ { "id", "name", "fileCount", "bytes", "codeLines",
    \\                     "totalLines", "complexitySupported", "importsSupported" } ],
    \\  "directories": [ { "path", "fileCount", "bytes", "codeLines",
    \\                     "totalLines", "direct" } ],
    \\  "files":       [ { "path", "ext", "language", "languageName", "bytes",
    \\                     "lines", "codeLines", "blankLines", "commentLines",
    \\                     "cyclomatic", "branchCount", "loopCount", "logicalCount",
    \\                     "maxNesting", "functionCount", "tokenCount",
    \\                     "contentScanned", "complexityAvailable", "importsAvailable",
    \\                     "importCount", "resolvedImportCount" } ],
    \\  "edges":       [ { "from", "to", "raw", "kind", "confidence", "line" } ],
    \\  "warnings":    [ { "code", "message", "path" } ]
    \\}
    \\
    \\Field names are emitted in lowerCamelCase (std.json default for the
    \\struct fields above). Optional metrics are `null` when unavailable.
    \\
    \\See docs/JSON_SCHEMA.md for field-by-field documentation.
    \\
;

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test "integer parsing helpers" {
    try std.testing.expectEqual(@as(?u64, 1024), parseU64("1024"));
    try std.testing.expectEqual(@as(?u64, null), parseU64("nope"));
    try std.testing.expectEqual(@as(?usize, 0), parseInt("0"));
    try std.testing.expectEqual(@as(?usize, null), parseInt("-1"));
}

test "schema text mentions every top-level key" {
    for ([_][]const u8{ "schemaVersion", "engine", "scan", "summary", "languages", "directories", "files", "edges", "warnings" }) |key| {
        try std.testing.expect(std.mem.indexOf(u8, SCHEMA_TEXT, key) != null);
    }
}
