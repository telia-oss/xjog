/**
 * Builds a positional-parameter accumulator for database drivers (e.g. PGlite)
 * whose query API accepts only numbered `$1, $2, …` placeholders rather than
 * named bindings.
 *
 * Each `nextParam(value)` call pushes the value onto `params` and returns its
 * placeholder, so the SQL text and the params array stay in lockstep no matter
 * which optional clauses are appended. Building these by hand desynchronises
 * easily (a skipped clause shifts every later placeholder), so query builders
 * should share this helper instead of re-declaring the closure.
 *
 * @param params Existing params array to append to. Defaults to a fresh array;
 *   pass an in-progress array to continue numbering from where it left off.
 */
export function createPositionalParameters(params: unknown[] = []): {
  params: unknown[];
  nextParam: (value: unknown) => string;
} {
  const nextParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  return { params, nextParam };
}
