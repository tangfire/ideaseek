interface PaperNode {
  node_id: string;
  title: string | null;
  status: string;
  detail: Record<string, unknown> | null;
}

export function paperSources(references: unknown, papers: PaperNode[]) {
  if (!Array.isArray(references) || references.some((id) => typeof id !== 'string' || !id.trim())) {
    return null;
  }
  return [...new Set(references as string[])].map((referenceId) => {
    // 只认保存的节点编号或原始论文编号；不按标题、顺序或编号前缀猜来源。
    const matches = papers.filter(
      (paper) => paper.node_id === referenceId || paper.detail?.paper_id === referenceId,
    );
    const paper = matches.length === 1 ? matches[0] : undefined;
    const verified =
      paper &&
      (paper.status === 'succeeded' || paper.status === 'parsed') &&
      (paper.detail?.input_source === 'text' || paper.detail?.input_source === 'abstract');
    return {
      reference_id: referenceId,
      paper_id: paper ? paper.node_id : null,
      title: paper ? paper.title : null,
      status: paper
        ? verified
          ? 'linked'
          : 'unverified'
        : matches.length > 1
          ? 'ambiguous'
          : 'missing',
    };
  });
}
