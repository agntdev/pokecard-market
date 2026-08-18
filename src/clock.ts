// One injectable time seam for marketplace records. Runtime code uses the real
// clock; tests can replace it without changing business logic.
let source = () => new Date();

export function now(): Date {
  return source();
}

export function setClockForTests(next: (() => Date) | undefined): void {
  source = next ?? (() => new Date());
}
