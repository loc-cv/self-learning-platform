// `npm run lab`'s core with a fake clock: the ticket, commands typed into the learner's shell,
// hints, check, debrief, solutions and reset as the lab prompt gives them, and the recording,
// which replays into the same world.

import { describe, expect, test } from 'vitest';
import { createScreen } from '@simlab/host';
import { startSession } from '@simlab/learn';
import { DEFAULT_START_TIME } from '@simlab/kernel';
import { baselineFor, createLabSession } from './labsession.ts';
import { replaySession } from './player.ts';

// eslint-disable-next-line no-control-regex -- removing the terminal styles the lab prompt adds
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function fakeLab(item: string, seed: number) {
  let clock = 0;
  let screenText = '';
  const session = createLabSession(
    { item, seed, startTime: DEFAULT_START_TIME, cols: 100, rows: 40 },
    { write: (d) => (screenText += d), note: () => {}, edit: (r) => r.content, gap: () => {}, now: () => clock },
  );
  const type = (keys: string, wait = 2000): void => {
    clock += 50;
    session.player.keys(keys);
    clock += wait;
    session.player.tick();
  };
  const screen = (): string => {
    const s = createScreen(100, 40);
    s.write(screenText);
    return s.text();
  };
  return { session, type, screen, cmd: (line: string) => plain(session.command(line)), advance: (ms: number) => ((clock += ms), session.player.tick()) };
}

describe('npm run lab', () => {
  test('a full attempt at the broken rollout: stuck, hints, a failing check, the fix, the debrief', () => {
    const t = fakeLab('k8s.troubleshooting.broken-rollout-01', 4);
    const { ns, app } = t.session.lab.variant.params as { ns: string; app: string };
    expect(plain(t.session.intro())).toContain(`${app} is down (namespace ${ns})`);
    t.type(`kubectl -n ${ns} get pods\r`);
    expect(t.screen()).toMatch(/ImagePullBackOff|ErrImagePull/);
    expect(t.cmd('debrief')).toContain('not solved yet');
    expect(t.cmd('hint')).toMatch(/^Hint 1 of 3\. Two symptoms/);
    const failing = t.cmd('check');
    expect(failing).toContain(`✗ The rollout of ${app} has finished`);
    expect(failing).toContain('wanted:');
    expect(failing).toContain('% of the checks');
    t.type(`kubectl -n ${ns} set image deployment/${app} ${app}=nginx:1.31.8\r`);
    expect(t.cmd('hint')).toMatch(/^Hint 2 of 3\./);
    expect(t.cmd('hint')).toMatch(/^Hint 3 of 3\..*app\.kubernetes\.io\/name/);
    expect(t.cmd('hint')).toContain('No more hints');
    // The Service's selector, fixed the way a learner without an editor would: apply a manifest.
    t.type(`printf 'apiVersion: v1\\nkind: Service\\nmetadata:\\n  name: ${app}\\n  namespace: ${ns}\\nspec:\\n  selector:\\n    app: ${app}\\n  ports:\\n  - port: 80\\n    targetPort: 80\\n' > svc.yaml\r`);
    t.type('kubectl apply -f svc.yaml\r');
    expect(t.screen()).toContain(`service/${app} configured`);
    t.advance(90_000);
    const passing = t.cmd('check');
    expect(passing).not.toContain('✗');
    expect(passing).toContain('Solved.');
    expect(t.cmd('debrief')).toContain('Two faults, one release.');
    expect(t.session.lab.events.map((e) => e.kind)).toEqual(['start', 'hint', 'check', 'hint', 'hint', 'check']);
    expect(t.session.lab.solutionViewed).toBe(false);
  });

  test('solution and reset ask first; reset gives a fresh world and a new recording', () => {
    const t = fakeLab('k8s.workloads.deployment-service-01', 2);
    const { ns, app } = t.session.lab.variant.params as { ns: string; app: string };
    expect(t.cmd('solution')).toContain('Type solution again');
    const shown = t.cmd('solution');
    expect(shown).toContain(`$ kubectl -n ${ns} create deployment ${app} --image=nginx:1.31.8`);
    expect(shown).toContain(`$ cat > /root/${app}.yaml <<'EOF'`);
    expect(t.session.lab.solutionViewed).toBe(true);
    t.type(`kubectl -n ${ns} create deployment ${app} --image=nginx:1.31.8\r`);
    expect(t.cmd('reset')).toContain('Type reset again');
    expect(t.cmd('hint')).toMatch(/^Hint 1/);
    expect(t.cmd('reset')).toContain('Type reset again');
    expect(t.cmd('reset')).toContain('back where it started');
    t.type(`kubectl -n ${ns} get deployments\r`);
    expect(t.screen()).toContain('No resources found');
    const logs = t.session.finish();
    expect(logs).toHaveLength(2);
    expect(logs[0]?.header).toMatchObject({ item: 'k8s.workloads.deployment-service-01', seed: 2, params: t.session.lab.variant.params });
    expect(logs[0]?.inputs.some((i) => i.kind === 'learn.action' && i.action === 'solution')).toBe(true);
    for (const log of logs) {
      const r = replaySession(log, () => {}, (h, ports) => startSession(baselineFor(h), ports).kernel);
      expect(r.divergedAt).toBeUndefined();
      expect(r.hash).toBe(r.recorded);
    }
  });

  test('unknown commands and help', () => {
    const t = fakeLab('k8s.scheduling.pending-pods-01', 1);
    expect(t.cmd('frobnicate')).toContain('Unknown lab command "frobnicate"');
    expect(t.cmd('help')).toContain('check      grade the current state of the world');
    expect(t.cmd('quit')).toBe('');
    expect(t.session.quit).toBe(true);
  });
});
