// Injectable in-process review facade. Continuations inherit the frozen file list;
// legacy persisted records without content cannot be reconstructed from its hash.
export function createNativeReviewService({ create, find }) {
  return {
    async createReview(args) {
      const result = await create(args)
      return result.ok ? { id: result.id, status: 'running' } : result
    },
    async replyReview({ prev, reply }) {
      const previous = find(prev)
      if (!previous) return { ok: false, error: 'Previous review not found' }
      if (typeof previous.content !== 'string' || !previous.content.trim()) return { ok: false, error: 'Previous review content unavailable' }
      return this.createReview({ content: previous.content, workdir: previous.workdir,
        files: previous.criteria?.files?.map(file => typeof file === 'string' ? file : file.path),
        prev, reply })
    },
  }
}
