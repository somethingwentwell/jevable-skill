import ts from 'typescript'

/** One vitest case found in a spec source file. */
export interface SpecCase {
  /** Title of the innermost enclosing describe ('' at top level). */
  describe: string
  title: string
  /** Normalized source text of the it.each(...) parameter list, if any. */
  each?: string
  /** Number of expect(...) calls inside the case body. */
  expects: number
}

const literalText = (node: ts.Node | undefined) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined

function countExpects(node: ts.Node | undefined): number {
  if (!node) return 0
  let count = 0
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'expect') count++
    ts.forEachChild(child, visit)
  }
  visit(node)
  return count
}

/**
 * Lists describe/it/it.each cases whose call starts before `boundary` (a character offset), using the
 * TypeScript parser rather than text matching, so multi-line titles and parameter lists are handled.
 */
export function specCasesBefore(source: string, fileName: string, boundary: number): SpecCase[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const cases: SpecCase[] = []
  const visit = (node: ts.Node, describe: string) => {
    if (ts.isCallExpression(node) && node.getStart(file) < boundary) {
      const callee = node.expression, title = literalText(node.arguments[0])
      if (title !== undefined && ts.isIdentifier(callee) && callee.text === 'describe') {
        ts.forEachChild(node, child => visit(child, title))
        return
      }
      const plainIt = ts.isIdentifier(callee) && callee.text === 'it'
      const eachIt = ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression)
        && ts.isIdentifier(callee.expression.expression) && callee.expression.expression.text === 'it'
        && callee.expression.name.text === 'each'
      if (title !== undefined && (plainIt || eachIt)) {
        const each = eachIt ? callee.arguments.map(argument => argument.getText(file)).join(', ').replace(/\s+/g, ' ') : undefined
        cases.push({ describe, title, ...(each === undefined ? {} : { each }), expects: countExpects(node.arguments[1]) })
        return
      }
    }
    ts.forEachChild(node, child => visit(child, describe))
  }
  visit(file, '')
  return cases
}
