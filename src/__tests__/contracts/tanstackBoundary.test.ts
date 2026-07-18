import fs from 'node:fs'
import path from 'node:path'

function sourceFiles(directory: string): Array<string> {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === `__tests__` ? [] : sourceFiles(entryPath)
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : []
  })
}

describe(`TanStack boundary`, () => {
  it(`keeps TanStack DB imports inside the core facade boundary`, () => {
    const sourceRoot = path.resolve(__dirname, `../..`)
    const imports = sourceFiles(sourceRoot).filter((filePath) =>
      /from ['"]@tanstack\/(?:db|react-db)['"]/.test(
        fs.readFileSync(filePath, `utf8`),
      ),
    )

    expect(imports).toHaveLength(1)
    expect(imports[0]).toBe(path.join(sourceRoot, `core/tanstack/facade.ts`))
  })

  it(`keeps the public barrel independent from the TanStack facade`, () => {
    const publicBarrel = fs.readFileSync(
      path.join(path.resolve(__dirname, `../..`), `index.ts`),
      `utf8`,
    )

    expect(publicBarrel).not.toMatch(/export[\s\S]*from ['"].*core\/tanstack/)
  })
})
