import { useLayoutEffect, useRef } from 'react';

export function ProjectTabs({
  tabs,
  active,
  onSelect,
  idPrefix,
}: {
  tabs: readonly string[];
  active: string;
  onSelect: (name: string) => void;
  idPrefix: string;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focused = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focused.current !== null && !tabs.includes(focused.current))
      buttons.current.get(active)?.focus();
  }, [tabs, active]);
  return (
    <div className="tabs" role="tablist" aria-label="项目内容" aria-orientation="horizontal">
      {tabs.map((name, index) => (
        <button
          key={name}
          ref={(button) => {
            if (button) buttons.current.set(name, button);
            else buttons.current.delete(name);
          }}
          id={`${idPrefix}-tab-${name}`}
          role="tab"
          tabIndex={active === name ? 0 : -1}
          aria-selected={active === name}
          aria-controls={`${idPrefix}-panel-${name}`}
          onFocus={() => {
            focused.current = name;
          }}
          onBlur={() => {
            focused.current = null;
          }}
          onClick={() => onSelect(name)}
          onKeyDown={(event) => {
            let target: number;
            switch (event.key) {
              case 'ArrowRight':
                target = (index + 1) % tabs.length;
                break;
              case 'ArrowLeft':
                target = (index - 1 + tabs.length) % tabs.length;
                break;
              case 'Home':
                target = 0;
                break;
              case 'End':
                target = tabs.length - 1;
                break;
              default:
                return;
            }
            event.preventDefault();
            const next = tabs[target]!;
            onSelect(next);
            buttons.current.get(next)?.focus();
          }}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
