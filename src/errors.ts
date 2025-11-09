export class IdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyError";
  }
}

export class IdempotencyCollisionError extends IdempotencyError {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyCollisionError";
  }
}

export class IdempotencySerializationError extends IdempotencyError {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencySerializationError";
  }
}
