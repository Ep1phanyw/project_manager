/**
 * 测试用的内存版状态存储 —— 与文件版同一个接口，但不出进程。
 * 写入是合并语义，和真实存储的部分更新一致。
 */
export function memoryStore() {
  const projects = new Map()

  return {
    listProjects: () => [...projects.keys()].sort(),
    read: (slug) => projects.get(slug) ?? null,
    write: (slug, documents) => {
      const current = projects.get(slug) ?? {
        project: null,
        acceptance: null,
        plan: null,
        parts: null,
      }
      projects.set(slug, { ...current, ...documents })
    },
  }
}
