/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it, vi} from 'vitest';
import {AdkApiServer} from '../../../dev/src/server/adk_api_server.js';
import {AgentLoader, FileModuleType} from '../../../dev/src/utils/agent_loader.js';

async function exists(filename: string): Promise<boolean> {
  try {
    await fs.access(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe.each([FileModuleType.CJS, FileModuleType.ESM])(
  'Real filesystem watch (%s)',
  (moduleType) => {
    it.each(['control', 'change'])(
      'keeps active imports and cleans retired bundles: %s',
      async (arm) => {
        const project = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-real-watch-'));
        const loader = new AgentLoader(
          project,
          {compile: true, bundle: true, moduleType},
          true,
        );
        const sessions = new InMemorySessionService();
        const server = new AdkApiServer({agentLoader: loader, sessionService: sessions});
        const gate = Promise.withResolvers<void>();
        const state = {started: false, gate: gate.promise};
        Object.assign(globalThis, {__adkRealWatchProbe: state});
        const observation: Record<string, unknown> = {moduleType, arm};
        let pending: Promise<Response> | undefined;
        try {
          await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({type: 'module'}));
          await fs.mkdir(path.join(project, 'node_modules', '@google'), {recursive: true});
          await fs.symlink(
            fileURLToPath(new URL('../../../core/', import.meta.url)),
            path.join(project, 'node_modules', '@google', 'adk'),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          const packages = ['first', 'second'].map((suffix) => `watch-${moduleType}-${arm}-${suffix}`);
          for (const name of packages) {
            const packageDir = path.join(project, 'node_modules', name);
            await fs.mkdir(packageDir);
            await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({name, type: 'module', exports: './index.js'}));
            await fs.writeFile(path.join(packageDir, 'index.js'), `export default ${JSON.stringify(name)};`);
          }
          const source = (version: number) => `import {BaseAgent, createEvent} from '@google/adk';
class WatchAgent_${moduleType}_${arm}_${version} extends BaseAgent {
  async *runAsyncImpl(context) {
    const name = context.userContent.parts[0].text;
    if (${version} === 1) {
      globalThis.__adkRealWatchProbe.started = true;
      await globalThis.__adkRealWatchProbe.gate;
    }
    const loaded = await import(name);
    yield createEvent({author: this.name, invocationId: context.invocationId,
      content: {role: 'model', parts: [{text: 'v${version}:' + loaded.default}]}});
  }
}
export const rootAgent = new WatchAgent_${moduleType}_${arm}_${version}({name: 'watch_agent'});`;
          const agentPath = path.join(project, 'agent.ts');
          await fs.writeFile(agentPath, source(1));
          const original = await loader.getAgentFile('agent');
          const originalPath = original.getFilePath();
          const originalDispose = original.dispose.bind(original);
          let disposalStarted = false;
          const disposed = Promise.withResolvers<void>();
          vi.spyOn(original, 'dispose').mockImplementation(async () => {
            disposalStarted = true;
            try {
              await originalDispose();
            } finally {
              disposed.resolve();
            }
          });
          for (const sessionId of ['old', 'new']) {
            await sessions.createSession({appName: 'agent', userId: 'user', sessionId});
          }
          await server.start();
          const run = (sessionId: string, name: string) => fetch(`${server.url}/run`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({appName: 'agent', userId: 'user', sessionId,
              newMessage: {role: 'user', parts: [{text: name}]}}),
          });
          const checkResponse = async (response: Response, expected: string) => {
            const body = await response.text();
            expect(response.status, body).toBe(200);
            const events = JSON.parse(body) as Array<{content?: {parts?: Array<{text?: string}>}}>;
            const texts = events.flatMap((event) => (event.content?.parts ?? []).flatMap((part) => part.text === undefined ? [] : [part.text]));
            expect(texts).toEqual([expected]);
          };
          pending = run('old', packages[0]);
          await vi.waitFor(() => expect(state.started).toBe(true), {timeout: 10000});
          let replacementPath: string | undefined;
          if (arm === 'change') {
            await fs.writeFile(agentPath, source(2));
            await vi.waitFor(async () => {
              const replacement = await loader.getAgentFile('agent');
              expect(replacement).not.toBe(original);
              replacementPath = replacement.getFilePath();
            }, {timeout: 10000});
            // Observe completion of a real disposal if invalidation started one.
            // The spy delegates unchanged to the filesystem implementation.
            if (disposalStarted) await disposed.promise;
            observation.oldBundleBeforeRelease = await exists(originalPath);
            expect(observation.oldBundleBeforeRelease, 'active request retains its compiled bundle').toBe(true);
            await checkResponse(await run('new', packages[1]), `v2:${packages[1]}`);
            observation.replacement = 'v2 HTTP 200';
          }
          gate.resolve();
          await checkResponse(await pending, `v1:${packages[0]}`);
          observation.original = 'v1 HTTP 200';
          if (arm === 'change') {
            await vi.waitFor(async () => expect(await exists(originalPath)).toBe(false));
            expect(await exists(replacementPath!)).toBe(true);
            observation.oldBundleRemovedAfterRelease = true;
          } else {
            expect(await exists(originalPath)).toBe(true);
          }
          await server.stop();
          await loader.disposeAll();
          expect(await exists(originalPath)).toBe(false);
          if (replacementPath) expect(await exists(replacementPath)).toBe(false);
          observation.finalCleanup = true;
        } finally {
          gate.resolve();
          await pending?.then((response) => response.text()).catch(() => {});
          await server.stop();
          await loader.disposeAll();
          vi.restoreAllMocks();
          Reflect.deleteProperty(globalThis, '__adkRealWatchProbe');
          await fs.rm(project, {recursive: true, force: true});
          if (process.env.ADK_WATCH_OBSERVATIONS) {
            await fs.appendFile(process.env.ADK_WATCH_OBSERVATIONS, JSON.stringify(observation) + '\n');
          }
        }
      },
    );
  },
);
