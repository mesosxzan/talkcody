export type ChangelogItem =
  | string
  | {
      title: string;
      description?: string;
      videoUrl?: string;
    };

export interface ChangelogContent {
  added?: ChangelogItem[];
  changed?: ChangelogItem[];
  fixed?: ChangelogItem[];
  removed?: ChangelogItem[];
  security?: ChangelogItem[];
  deprecated?: ChangelogItem[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  en: ChangelogContent;
  zh: ChangelogContent;
}

// Changelog data - update this when releasing new versions
// Only include the most recent versions that users care about
export const CHANGELOG_DATA: ChangelogEntry[] = [
  {
    version: '0.7.0',
    date: '2026-05-06',
    en: {
      added: [
        'OpenAI Subscription WebSocket Transport with Major Performance Gains: ChatGPT subscription Codex requests can now stream messages incrementally over a persistent WebSocket connection, significantly reducing total runtime for long-running agent tasks.',
        'Multi-Model Rotation: Small Model and Message Compaction now support ordered fallback model chains with manual priority control.',
      ],
      changed: [
        'Reasoning Display Improvements: Model reasoning is now shown in a dedicated collapsible section, with better live streaming and persistence during long responses.',
        'Path-Aware Local Skill Management: Editing and deleting local skills now targets the exact on-disk path, including project-local and user-local skill folders.',
      ],
      fixed: [
        'Fixed a bug related to deleting chat messages while a response was still loading or streaming.',
        'Fixed local skill lookup failures for skills stored outside the default app data directory.',
        'Improved keep-awake reliability for long-running tasks so sleep prevention is less likely to be released too early.',
      ],
    },
    zh: {
      added: [
        'OpenAI 订阅 支持 WebSocket 传输，性能大幅提升：通过 ChatGPT 订阅使用 Codex 请求时，现可使用持久 WebSocket 连接增量传输消息，大幅缩短长时间运行的 Agent 总耗时。',
        '多模型轮训：Small Model 与 Message Compaction 现支持按优先级配置备用模型链，并可手动调整顺序。',
      ],
      changed: [
        '思考过程展示优化：模型 reasoning 现在会显示在独立的可折叠区域中，并改进长响应过程中的实时流式展示与持久化效果。',
        '本地 Skills 路径级管理：编辑和删除本地 Skills 时现在会精确定位到磁盘路径，支持项目级与用户级技能目录。',
      ],
      fixed: [
        '修复响应仍在加载或流式返回时无法删除聊天消息的 bug。',
        '修复存放在默认 app data 目录之外的本地 Skills 可能无法正确查找的问题。',
        '提升长任务场景下 keep-awake 的可靠性，减少防休眠状态过早释放的问题。',
      ],
    },
  },
];

export function getChangelogForVersion(version: string): ChangelogEntry | undefined {
  return CHANGELOG_DATA.find((entry) => entry.version === version);
}

export function getLatestChangelog(): ChangelogEntry | undefined {
  return CHANGELOG_DATA[0];
}
