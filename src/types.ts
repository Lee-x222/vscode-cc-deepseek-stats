export interface ModelCost {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  cost: number;
}

/** ccusage JSON 输出的单日数据 */
export interface DailyEntry {
  date: string;
  agent: string;
  models: string[];
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  totalTokens: number;
  cost: number;
  modelBreakdown: ModelCost[];
}

/** ccusage JSON 输出的完整结果 */
export interface CcUsageResult {
  entries: DailyEntry[];
  totals: {
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
    totalTokens: number;
    cost: number;
  };
  modelBreakdown: ModelCost[];
}

/** 发送给 WebView 的消息 */
export interface StatsMessage {
  type: 'update';
  status: 'loading' | 'ok' | 'empty' | 'error';
  error?: string;
  today: DailyEntry | null;
  allDays: DailyEntry[];
  totals: CcUsageResult['totals'];
  mcpServers: string[];
  memoryFiles: string[];
  projectFiles: string[];
  modelBreakdown: ModelCost[];
  /** 所有项目的全局总费用 */
  globalCost: number;
  /** 非当前项目的费用之和 */
  otherCost: number;
  /** 本月的汇总数据 */
  monthlyTotals: CcUsageResult['totals'];
  /** 本月的分模型费用 */
  monthlyModelBreakdown: ModelCost[];
  /** 本月其他项目费用之和 */
  monthlyOtherCost: number;
  /** 本月全局总费用（当前项目 + 其他项目） */
  monthlyGlobalCost: number;
  /** DeepSeek 平台账户余额 */
  balance: number;
  /** 平台余额是否低于预警阈值 */
  overThreshold: boolean;
  /** 是否已配置 API Key（用于首次使用引导） */
  authConfigured: boolean;
  /** 当前生效的余额预警阈值 */
  balanceThreshold: number;
  /** 工作区根目录，WebView 用来打开文件 */
  workspaceRoot: string;
  /** 用户 HOME 目录 */
  home: string;
  /** 当前项目的目录 slug */
  projectSlug: string;
  /** 可用技能列表 */
  skills: { name: string; description: string }[];
}
