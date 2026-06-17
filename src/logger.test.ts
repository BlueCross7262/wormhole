import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logger.js";

function captureStderr(fn: () => void): string[] {
  const written: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return written;
}

describe("createLogger — level filtering", () => {
  test("debug suppressed when level=info", () => {
    const written = captureStderr(() => {
      const log = createLogger("info");
      log.debug("should not appear");
    });
    assert.equal(written.length, 0);
  });

  test("debug and info suppressed when level=warn", () => {
    const written = captureStderr(() => {
      const log = createLogger("warn");
      log.debug("no");
      log.info("no");
    });
    assert.equal(written.length, 0);
  });

  test("warn and error emitted when level=warn", () => {
    const written = captureStderr(() => {
      const log = createLogger("warn");
      log.warn("warn-msg");
      log.error("err-msg");
    });
    assert.equal(written.length, 2);
  });

  test("error always emitted at info level", () => {
    const written = captureStderr(() => {
      const log = createLogger("info");
      log.error("critical error");
    });
    assert.equal(written.length, 1);
    assert.ok(written[0].includes("critical error"));
  });

  test("debug emitted when level=debug", () => {
    const written = captureStderr(() => {
      const log = createLogger("debug");
      log.debug("debug-msg");
    });
    assert.equal(written.length, 1);
    assert.ok(written[0].includes("debug-msg"));
  });

  test("all four levels emitted when level=debug", () => {
    const written = captureStderr(() => {
      const log = createLogger("debug");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    assert.equal(written.length, 4);
  });

  test("only error emitted when level=error", () => {
    const written = captureStderr(() => {
      const log = createLogger("error");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("only-this");
    });
    assert.equal(written.length, 1);
    assert.ok(written[0].includes("only-this"));
  });
});

describe("createLogger — output goes to stderr not stdout", () => {
  test("info message written to stderr not stdout", () => {
    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];

    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);

    process.stderr.write = (chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    };
    process.stdout.write = (chunk: unknown) => {
      stdoutLines.push(String(chunk));
      return true;
    };

    try {
      const log = createLogger("info");
      log.info("to-stderr");
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }

    assert.ok(stderrLines.some((l) => l.includes("to-stderr")), "stderr should contain the message");
    assert.ok(!stdoutLines.some((l) => l.includes("to-stderr")), "stdout should NOT contain the message");
  });

  test("error message written to stderr not stdout", () => {
    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];

    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);

    process.stderr.write = (chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    };
    process.stdout.write = (chunk: unknown) => {
      stdoutLines.push(String(chunk));
      return true;
    };

    try {
      const log = createLogger("error");
      log.error("only-stderr");
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }

    assert.ok(stderrLines.some((l) => l.includes("only-stderr")));
    assert.equal(stdoutLines.filter((l) => l.includes("only-stderr")).length, 0);
  });
});

describe("createLogger — message formatting", () => {
  test("format contains [INFO] and message text (no prefix)", () => {
    const written = captureStderr(() => {
      const log = createLogger("info");
      log.info("hello world");
    });
    assert.ok(written.length > 0);
    const line = written[0];
    assert.ok(line.includes("[INFO]"), `expected [INFO] in: ${line}`);
    assert.ok(line.includes("hello world"), `expected message in: ${line}`);
  });

  test("format contains [prefix] before [LEVEL] when prefix provided", () => {
    const written = captureStderr(() => {
      const log = createLogger("info", "mycomp");
      log.info("prefixed message");
    });
    assert.ok(written.length > 0);
    const line = written[0];
    assert.ok(line.includes("[mycomp]"), `expected [mycomp] tag in: ${line}`);
    assert.ok(line.includes("[INFO]"), `expected [INFO] in: ${line}`);
    assert.ok(line.includes("prefixed message"));
    assert.ok(line.indexOf("[mycomp]") < line.indexOf("[INFO]"), "prefix tag should come before level tag");
  });

  test("object extra arg serialized as JSON", () => {
    const written = captureStderr(() => {
      const log = createLogger("info");
      log.info("msg", { key: "value" });
    });
    assert.ok(written[0].includes('{"key":"value"}'), `expected JSON in: ${written[0]}`);
  });

  test("non-object extra args serialized as string", () => {
    const written = captureStderr(() => {
      const log = createLogger("info");
      log.info("msg", 42, true);
    });
    const line = written[0];
    assert.ok(line.includes("42"), `expected '42' in: ${line}`);
    assert.ok(line.includes("true"), `expected 'true' in: ${line}`);
  });

  test("level tag is uppercase in output", () => {
    const written = captureStderr(() => {
      const log = createLogger("debug");
      log.debug("x");
      log.warn("y");
    });
    assert.ok(written[0].includes("[DEBUG]"));
    assert.ok(written[1].includes("[WARN]"));
  });

  test("no extra args — message not followed by trailing space", () => {
    const written = captureStderr(() => {
      const log = createLogger("info");
      log.info("clean");
    });
    const line = written[0];
    assert.ok(!line.endsWith(" \n") && !line.endsWith("  "), `unexpected trailing space: ${JSON.stringify(line)}`);
    assert.ok(line.includes("clean"));
  });
});

describe("WORMHOLE_LOG_LEVEL env — createLogger respects provided level", () => {
  test("debug-level logger emits debug when explicitly created at debug", () => {
    const written = captureStderr(() => {
      const log = createLogger("debug");
      log.debug("env-driven debug");
    });
    assert.ok(written.some((l) => l.includes("env-driven debug")));
  });

  test("info-level logger suppresses debug", () => {
    const written = captureStderr(() => {
      const log = createLogger("info");
      log.debug("should be suppressed");
    });
    assert.equal(written.length, 0);
  });
});
