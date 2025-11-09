import { canonicalize, hashCanonicalValue } from "./utils.js";
import type { HashAlgorithm } from "./types.js";

export interface SteadyKeyOptions {
  readonly hashAlgorithm?: HashAlgorithm;
}

export const steadyKey = (payload: unknown, options: SteadyKeyOptions = {}): string => {
  const canonicalPayload = canonicalize(payload);
  const algorithm = options.hashAlgorithm ?? "sha256";
  return hashCanonicalValue(canonicalPayload, algorithm);
};
