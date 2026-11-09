import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
const schema = JSON.parse(execFileSync('cargo', ['run', '--quiet', '-p', 'delta-protocol', '--example', 'schema'], { encoding: 'utf8' }));
const types = await compile(schema, 'Contract', { bannerComment: '', additionalProperties: false, unknownAny: true });
await mkdir('packages/client/src', { recursive: true });
await writeFile('packages/client/src/generated.ts', types);
await writeFile('packages/client/schema.json', JSON.stringify(schema, null, 2) + '\n');
