# 中国法律 Skill 与流式合同起草

本轮实现：通用交易起草 fallback、现有专项规则增强、独立交易事实留存、生成方案和 Skill 版本记录、模型 SSE 到网站的实时预览。

## 运行路径

Pi Agent Core → OpenAI-compatible SSE → 白名单文字预览 → Sites/Node SSE → assistant-ui。
阶段结果继续经过结构校验、事实校验、确认、独立一致性检查及 Word 保存；流式预览不是最终文档，不存作消息或审核版本。取消及过期租约继续通过原有持久化状态隔离，流中断不自动承诺文件生成成功。关页后的可靠后台调度不是本轮能力。

通用交易使用 general 作为兼容现有持久化格式的起草模式标识，不要求专业合同类型。设备、收益分配和运营模块按交易内容加入；事实跨规则切换保留并在摘要完整展示。现有专项规则完整匹配仍走原路径；任意多规则包的语义组合不是本轮已验证能力。

## 验证

- npm run typecheck / npm run typecheck:cloud
- npm test：67 项，63 通过，4 项依赖外部环境的检查跳过。
- npm run build
- node --import tsx scripts/pi-worker-smoke.mjs：隔离运行环境内，SSE 阶段执行、Word 下载、幂等确认及取消隔离。
- CONTRACT_PI_LIVE=1 node --env-file=.env.local --import tsx scripts/pi-worker-smoke.mjs：真实模型采购流程，成功保存并下载 Word。
- node --env-file=.env.local --import tsx scripts/general-live-smoke.ts：真实模型咖啡机运营分成；已通过；103 次实时预览事件，约 24 秒完成整理、生成与核对，结果写入忽略的 .data/qa。
- node --import tsx scripts/stream-preview.mjs：隔离本地网页，合成流式模型，仅用于交互验收，不是线上模型质量证明。

运行 Skill 的边界见 vendor/legal-skills/ADAPTATION.md。部署结果与律师实际审定须单独记录。

桌面浏览器：隔离本地页面实际登录、提交需求、观察流式预览、确认摘要、显示下载入口，控制台无错误或警告。使用合成流式模型验证界面；真实模型能力由以上独立测试验证。
