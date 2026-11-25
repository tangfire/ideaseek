export function ExpandableText({ text, label }: { text: string; label: string }) {
  const characters = Array.from(text);
  const preview = characters
    .slice(0, 180)
    .join('')
    .split(/\r\n|\r|\n/)
    .slice(0, 3)
    .join('\n');
  if (characters.length <= 180 && text.split(/\r\n|\r|\n/).length <= 3) {
    return <div className="text-body">{text}</div>;
  }
  return (
    <div className="expandable-text">
      <details key={text}>
        <summary>
          <span className="text-expand-label">展开{label}</span>
          <span className="text-collapse-label">收起{label}</span>
        </summary>
        <div className="text-body">{text}</div>
      </details>
      <div className="text-preview">{preview}…</div>
    </div>
  );
}
