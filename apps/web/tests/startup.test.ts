import { describe, expect, it } from "vitest";
import { ConfigError, ObjectStoreError } from "@vast-comfy/core";
import { startupMessage } from "../src/startup.js";

describe("startup error line", () => {
  it("names the bad key for config, profile, Vast and object-store setup errors", () => {
    expect(startupMessage(new ConfigError(["GALLERY_PAGE_SIZE must be a positive integer"]))).toBe(
      "startup failed: invalid configuration: GALLERY_PAGE_SIZE must be a positive integer",
    );
    expect(startupMessage(new ObjectStoreError("GALLERY_S3_ENDPOINT must be an http(s) URL without credentials"))).toBe(
      "startup failed: GALLERY_S3_ENDPOINT must be an http(s) URL without credentials",
    );
  });

  it("reduces any other error to its name, so no value can leak", () => {
    expect(startupMessage(new TypeError("secret-value-123"))).toBe("startup failed: TypeError");
    expect(startupMessage("plain")).toBe("startup failed: error");
  });
});
