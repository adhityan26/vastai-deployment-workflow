// The two errors of the profile layer, in their own module so other modules (styles) can use them without a cycle.

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export class GenerateInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GenerateInputError";
    this.code = code;
  }
}
