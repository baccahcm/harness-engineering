export class HarnessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class PolicyViolation extends HarnessError {
  constructor(public readonly policyId: string, message: string) {
    super("POLICY_VIOLATION", `${policyId}: ${message}`);
  }
}

export class InvalidTransition extends HarnessError {
  constructor(from: string, to: string) {
    super("INVALID_TRANSITION", `Invalid task transition: ${from} -> ${to}`);
  }
}

export class ConfigValidationError extends HarnessError {
  constructor(message: string) { super("CONFIG_VALIDATION_ERROR", message); }
}

export class InstallationConflict extends HarnessError {
  constructor(message: string) { super("INSTALLATION_CONFLICT", message); }
}
