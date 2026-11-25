import type { ExperimentResult, IdeaSummary, PaperCard } from './types';

export type OutputKind = 'paper' | 'idea' | 'experiment';
export type OutputNavigation = (kind: OutputKind, id: string) => void;

export function outputId(kind: OutputKind, id: string): string {
  return `output-${kind}-${encodeURIComponent(id)}`;
}

function RelatedItems({
  title,
  items,
  empty,
  onNavigate,
}: {
  title: string;
  items: Array<{ kind: OutputKind; id: string; title: string }>;
  empty: string;
  onNavigate: OutputNavigation;
}) {
  return (
    <div className="output-relations">
      <strong>{title}</strong>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <button className="output-link" onClick={() => onNavigate(item.kind, item.id)}>
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{empty}</p>
      )}
    </div>
  );
}

export function PaperRelations({
  paper,
  ideas,
  onNavigate,
}: {
  paper: PaperCard;
  ideas: IdeaSummary[];
  onNavigate: OutputNavigation;
}) {
  return (
    <RelatedItems
      title="引用此论文的想法"
      empty="尚无已记录的想法引用。"
      onNavigate={onNavigate}
      items={ideas
        .filter((idea) =>
          idea.paper_sources?.some((source) => source.paper_id === paper.external_paper_id),
        )
        .map((idea) => ({ kind: 'idea', id: idea.external_idea_id, title: idea.title }))}
    />
  );
}

export function IdeaRelations({
  idea,
  papers,
  experiments,
  onNavigate,
}: {
  idea: IdeaSummary;
  papers: PaperCard[];
  experiments: ExperimentResult[];
  onNavigate: OutputNavigation;
}) {
  return (
    <>
      <div className="output-relations">
        <strong>来源论文</strong>
        {idea.paper_sources && idea.paper_sources.length > 0 ? (
          <ul>
            {idea.paper_sources.map((source) => {
              const paper = papers.find((entry) => entry.external_paper_id === source.paper_id);
              return (
                <li key={source.reference_id}>
                  {paper ? (
                    <>
                      <button
                        className="output-link"
                        onClick={() => onNavigate('paper', paper.external_paper_id)}
                      >
                        {paper.title}
                      </button>
                      {source.status === 'unverified' ? (
                        <span className="muted"> · 材料或分析状态待核验</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted">
                      {source.reference_id} ·{' '}
                      {source.status === 'ambiguous'
                        ? '编号对应多个记录，无法确定来源'
                        : '当前运行未找到来源论文'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">
            {idea.paper_sources ? '记录中未关联来源论文。' : '未记录可核验的来源论文编号。'}
          </p>
        )}
      </div>
      <RelatedItems
        title="关联实验"
        empty="尚无已记录的关联实验。"
        onNavigate={onNavigate}
        items={experiments
          .filter((experiment) => experiment.idea_id === idea.external_idea_id)
          .map((experiment) => ({
            kind: 'experiment',
            id: experiment.external_spec_id,
            title: `${experiment.external_spec_id}${experiment.status === 'simulated' ? '（模拟演示）' : ''}`,
          }))}
      />
    </>
  );
}

export function ExperimentRelations({
  experiment,
  ideas,
  onNavigate,
}: {
  experiment: ExperimentResult;
  ideas: IdeaSummary[];
  onNavigate: OutputNavigation;
}) {
  const idea = ideas.find((entry) => entry.external_idea_id === experiment.idea_id);
  return (
    <RelatedItems
      title="实验对象"
      onNavigate={onNavigate}
      empty={
        experiment.idea_id
          ? `${experiment.idea_id} · 当前运行未找到关联想法。`
          : '未记录关联想法编号。'
      }
      items={idea ? [{ kind: 'idea', id: idea.external_idea_id, title: idea.title }] : []}
    />
  );
}
