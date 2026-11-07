import {build} from 'esbuild'
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {dirname,join,resolve,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {isBuiltin} from 'node:module'
import assert from 'node:assert/strict'
import {assertOwnedBuildInputs} from './standalone-boundary.mjs'

// Separate opt-in artifact; the default SQLite builder's strict no-PG rule is unchanged.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),stem='release-sqlite-coordinated'
const result=await build({absWorkingDir:root,entryPoints:['src/releases/sqlite-coordinated-entry.ts'],outfile:`dist/${stem}-runtime.mjs`,
  plugins:[{name:'node-only-pg-transport',setup(api){api.onResolve({filter:/^\.\/stream$/},args=>args.importer.endsWith('/node_modules/pg/lib/connection.js')
    ?{path:join(root,'src/storage/node-pg-stream.cjs')}:undefined)}}],
  bundle:true,platform:'node',format:'esm',target:'node22.19',metafile:true,legalComments:'eof',
  banner:{js:'import { createRequire as __jevableCreateRequire } from "node:module"; const require = __jevableCreateRequire(import.meta.url);'}})
for(const output of Object.values(result.metafile.outputs))for(const imported of output.imports)
  assert(imported.external&&isBuiltin(imported.path),`Optional runtime requires disallowed code: ${imported.path}`)
const inputs=Object.keys(result.metafile.inputs)
assert(inputs.includes('src/runtime/local.ts')&&inputs.includes('src/http/postgres-rate-limits.ts')&&inputs.includes('node_modules/pg/lib/client.js'))
for(const forbidden of ['src/runtime/postgres.ts','src/storage/postgres.ts','src/http/postgres.ts','src/releases/postgres-entry.ts'])assert(!inputs.includes(forbidden),`Optional SQLite app includes PostgreSQL workflow owner: ${forbidden}`)
assert(!inputs.some(p=>p.includes('pg/lib/native')||p.includes('pg-cloudflare')))
await assertOwnedBuildInputs(root,inputs)
const packages=new Map()
for(const input of inputs){
  assert(!/(?:jarness|harness|@deepseek-ai)\//iu.test(input)&&!input.startsWith('../'),`External source input: ${input}`)
  if(!input.startsWith('node_modules/'))continue
  const parts=input.split('/'),directory=parts.slice(0,parts[1].startsWith('@')?3:2).join('/')
  if(packages.has(directory))continue
  const manifest=JSON.parse(await readFile(join(root,directory,'package.json'),'utf8'))
  const names=(await readdir(join(root,directory))).filter(n=>/^(license|copying|notice)(\.|$)/iu.test(n)).sort()
  const notices=await Promise.all(names.map(n=>readFile(join(root,directory,n),'utf8')))
  if(!notices.length){const readme=await readFile(join(root,directory,'README.md'),'utf8'),embedded=readme.match(/^##? license\s*\n([\s\S]*)/im)?.[1]?.trim()
    assert(embedded?.includes('Copyright')&&embedded.includes('Permission is hereby granted'),`Missing license notice for ${manifest.name}`);notices.push(embedded)}
  packages.set(directory,{name:manifest.name,version:manifest.version,notices:notices.join('\n\n')})
}
const notice=['Jevable workflow runtime — development distribution; proprietary core terms are not yet published.',
  await readFile(join(root,'notices/harness-MIT.txt'),'utf8'),await readFile(join(root,'notices/preview-dependencies.txt'),'utf8'),
  ...[...packages.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`${p.name} ${p.version}\n\n${p.notices}`)].join('\n\n---\n\n')
await writeFile(join(root,`dist/${stem}-NOTICES.txt`),notice)
const bytes=await readFile(join(root,`dist/${stem}-runtime.mjs`)),metadata={schemaVersion:1,storage:'sqlite',rateCoordinator:'postgres',
  sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,dependencies:[...packages.values()].map(({name,version})=>({name,version})),
  external:'node-builtins-only',inputs:inputs.map(p=>relative(root,resolve(root,p)))}
await writeFile(join(root,`dist/${stem}-runtime.json`),JSON.stringify(metadata,null,2)+'\n')
console.log(`Bundled optional SQLite workflow/PostgreSQL quota runtime (${bytes.length} bytes, ${packages.size} dependency notices).`)
