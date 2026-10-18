export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: body instanceof FormData ? {} : body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store', signal:AbortSignal.timeout(path.includes('/jobs/')?80000:body instanceof FormData?(path.includes('/materials')?120000:60000):20000) }).catch(() => { throw new Error('暂时无法连接服务，请恢复连接后重试。'); });
  const value = await response.json().catch(() => ({})) as {data?: unknown; code?: string; error?: string};
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('auth/') && typeof window !== 'undefined') window.dispatchEvent(new Event('contract-session-expired'));
    const messages: Record<string,string> = {
      AI_NOT_CONFIGURED:'尚未配置模型服务。请联系管理员完成配置，或明确选择示例体验。',
      AI_PROVIDER_ERROR:'模型服务返回错误，请稍后重试。你的已有合同没有改变。',
      AI_PROVIDER_UNAVAILABLE:'暂时无法连接模型服务，请检查配置后重试。',
      AI_EMPTY_RESPONSE:'模型没有返回有效内容，请重试。',
      AI_INVALID_CONTRACT:'模型返回的合同格式不完整，未保存新版本，请重试。',
      CSRF_BLOCKED:'当前访问地址与网站配置不一致，请使用管理员提供的网站地址。',
      AI_INVALID_RESPONSE:'模型返回的合同格式不完整，未保存为新版本。请重试。',
      DEMO_DISABLED:'当前环境未开放示例体验。',
      REVIEW_VERSION_FROZEN:'当前版本正在审核，请通过审核沟通补充信息。',
      REVIEW_ALREADY_OPEN:'这份合同已有进行中的审核任务。',
      REVIEW_COMPLETED:'此审核已经交付，文件和审核记录已锁定。',
      VERSION_NOT_CURRENT:'请先保存最新审阅版，再确认交付。',
      EDITOR_SAVE_PENDING:'文档仍在保存，请收到保存确认后再交付。',
      ONLYOFFICE_NOT_CONFIGURED:'在线编辑器尚未配置，可下载修改后上传 Word。',
      UNAUTHENTICATED:'登录已过期，请重新登录。',
      REQUEST_TOO_LARGE:'提交内容过大，请缩短内容或减小文件后重试。',
      SELF_DISABLE_FORBIDDEN:'不能停用当前登录的管理员账户。',
      LAST_ADMIN_DISABLE_FORBIDDEN:'平台至少需要保留一个正常的管理员账户。',
      AUTH_RATE_LIMITED:'尝试次数过多，请稍后再试。',
      AUTH_RATE_LIMIT_UNAVAILABLE:'登录服务暂时不可用，请稍后再试。',
      INVALID_CREDENTIALS:'邮箱或密码不正确。',
      EMAIL_EXISTS:'此邮箱已注册，请直接登录。',
      FORBIDDEN:'你没有执行此操作的权限。',
      CONTRACT_NOT_FOUND:'合同不存在，或你没有访问权限。',
      VERSION_NOT_FOUND:'文档版本不存在，或你没有访问权限。',
      INVALID_FILE_TYPE:'请上传有效的 .docx Word 文件。',
      FILE_TOO_LARGE:'文件为空或超过允许大小。',
      INVALID_DOCX:'文件不是有效的 Word 文档，请重新选择。',
      INVALID_INPUT:'请检查输入信息是否完整、格式是否正确。',
      INTERNAL_ERROR:'服务暂时不可用，请稍后重试。',
    };
    throw new Error(messages[value.code || ''] || (/[^\x00-\x7F]/.test(value.error||'') ? value.error : `请求未完成（${response.status}），请检查后重试。`));
  }
  return value.data as T;
}
export const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
