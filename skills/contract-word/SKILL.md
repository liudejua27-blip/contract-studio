---
name: contract-word
description: 将已确认的通用合同组织成结构化中文正文、清单和签署页，通过平台工具生成可下载 Word 并核对交付结果。
---

# 合同 Word 交付（平台适配版 3.0.0）

根据交易选择文档结构。正文用于当事人履行，来源、规则应用记录和律师事项留在版本检查记录，不混入合同。

## 选择段落、表格和附件

短约定用段落；具备两行以上可比较项目（商品规格和数量、分期付款、阶段交付、交接清单）时优先使用真实 table，不用空格、竖线文本或 Markdown 假装表格。节点、金额、条件按同一行对应，付款义务在正文中明确，不只依赖附件。不得为了填表添加未确认价格、日期、数量或承诺。

sections/attachments 使用 blocks 时，每项包含 kind：paragraph{text}、heading{text,level:2或3}、list{items}、table{columns,rows}。content 留空，平台从 blocks 得到唯一核对正文。表头和每行列数一致，支持 2–6 列；金额写明币种和单位，长说明放宽列或移入段落。下级标题只写标题，连续层级由生成器编号，不跳过父层级。

附件只在实际需要时建立，正文引用的名称与真实附件一致。短合同可以没有附件。交接或验收附件需要独立确认时设置 signatureRequired，普通说明附件不机械添加签署区。

## 主体与签署

parties 与已确认 participants 逐方对应，不漏掉丙方或特殊角色。企业、个人、代理签署分别处理。已知资料使用 registrationId、address、contactName、phone、email、legalRepresentative、authorizedRepresentative；引用各自所属方的事实，不使用全局搜索替代归属判断。不能用 details 绕过归属要求。

用户已明确的各方资料必须写入对应结构化字段，不得省略。尤其是 partyB_signatureMethod 只属于乙方，明确“乙方签名并盖章”时必须写入乙方 signatureMethod=signature_and_seal，不能只写在正文或 signing。signatureMethod 仅在用户明确约定时填写 signature、seal 或 signature_and_seal；未知省略，由平台生成中性签署位。signing 只保留有依据的签署地点等说明。签署日期由实际签署人填写，不以生成日期代替。正文不重复画主体表或签字区。

缺少非必要签署资料时省略，交由签署资料卡提示。代理授权和主体真实性由律师核对，不因字段已经填写就宣称已核验。

## 生成与交付

平台生成器使用 cn-contract-v2：A4、宋体小四、正文 1.5 倍行距、连续条号、总页数、附件分页和签署留白。这是产品规范，不是所有合同统一的法定格式。

交付前检查：各方对应、表格行列及金额、正文和结构化内容一致、实际附件与引用一致、签署说明进入 Word。平台按已确认事实核对、生成真实 DOCX 并存储成功，才返回下载入口。submit_contract_draft 只提交候选内容，不代表已保存、已送审或律师认可；没有文件结果时不得编造下载链接。

结构检查与视觉验收分开。DOCX 结构通过不代表每页均无溢出，也不代表 Word/WPS 分别验收。没有渲染工具和图像检查结果时，不声称已完成视觉核验。用户可以先下载 AI 初稿，再提交同一保存版本供律师审核。
