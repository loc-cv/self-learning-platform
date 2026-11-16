// The item list: every lab in the bundled packs, with the attempt in progress if there is one.
// (The home screen with today's session is phase 12.)

import type { Item } from '@simlab/learn';
import { ITEMS, skillTitle } from '../content.ts';
import type { Store } from './storage.ts';
import { Button, Dots } from './ui.tsx';

interface Props {
  store: Store;
  current?: string;
  start(item: Item, fresh: boolean): void;
  onClose?: () => void;
}

export function ItemPicker(p: Props) {
  return (
    <div className="picker">
      <header className="picker-head">
        <h1>Labs</h1>
        <p>Each lab drops you into a working cluster with a ticket to solve. Grading reads the final state of the world, never the commands you typed.</p>
      </header>
      <ul className="picker-list">
        {ITEMS.filter((i) => i.kind === 'lab').map((item) => {
          const attempt = p.store.attempt(item.id);
          return (
            <li key={item.id} className={`picker-item${p.current === item.id ? ' is-current' : ''}`}>
              <div className="picker-main">
                <div className="picker-title">{item.title}</div>
                <div className="picker-meta">
                  <Dots n={item.difficulty} of={5} />
                  <span>about {item.targetMinutes} min</span>
                  <span className="picker-id">{item.id}</span>
                </div>
                <div className="chips">
                  {item.skills.map((s) => (
                    <span key={s} className="chip">
                      {skillTitle(s)}
                    </span>
                  ))}
                </div>
              </div>
              <div className="picker-actions">
                {attempt ? (
                  <>
                    <Button variant="primary" onClick={() => p.start(item, false)}>
                      {p.current === item.id ? 'Back to it' : 'Resume'}
                    </Button>
                    <Button variant="ghost" small title="Another variant of this lab; the attempt in progress is discarded" onClick={() => p.start(item, true)}>
                      New variant
                    </Button>
                  </>
                ) : (
                  <Button variant="primary" onClick={() => p.start(item, true)}>
                    Start
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {p.onClose ? (
        <div className="picker-foot">
          <Button variant="ghost" onClick={p.onClose}>
            Close
          </Button>
        </div>
      ) : null}
    </div>
  );
}
