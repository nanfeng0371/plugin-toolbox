/**
 * 调课助手配置
 */

// API 基础地址
export const API_BASE = 'https://renewal-calendar-7ff2rtj4f876144-1259283480.ap-shanghai.app.tcloudbase.com/tk-api';

// ai-genesis 后台地址（用于跳转获取 Token）
export const AI_GENESIS_URL = 'https://ai-genesis.yuaiweiwu.com';

// Token 存储 key
export const EF_TOKEN_KEY = 'tk_ef_token';
export const EF_USER_KEY = 'tk_ef_user';

// 角色等级
export const ROLE_LEVELS = {
  superAdmin: 6,
  operationLeader: 5,
  centerLeader: 4,
  subjectLeader: 3,
  gradeLeader: 2,
  counselor: 1,
};

// JWT 格式正则
export const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
