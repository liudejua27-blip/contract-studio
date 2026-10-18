/** Non-commercial drafting rules. They never create an agreed price, date or licence. */
export const PROFESSIONAL_DEFAULTS:Record<string,string>={
 tax:'双方各自依法承担应由其承担的税费，不擅自增加已明确的合同价款。',
 invoice:'收款方应依法就实际交易开具合法有效的发票。',
 acceptance:'按照合同所载工作、成果或商品清单逐项核对。发现不符合约定的，应说明具体问题，由提供方修正后重新提交核对；沉默不视为验收通过。纠正不符合约定的成果不以预设修改次数为前提；超出原范围的新需求由双方另行确认范围、费用与期限。',
 breach:'一方未按约定履行，另一方可通知其补救；经催告后仍不履行致使合同目的不能实现的，可依法解除。已履行部分据实结算，未履行部分退还对应款项，损失赔偿依法处理。不预设固定违约金或责任上限。',
 disputes:'适用中国大陆法律。争议先由双方协商，协商不成，向依法有管辖权的人民法院起诉。',
 ip:'接收方可为本合同已明确的业务目的使用交付成果；源码及修改需求以已约定的交付范围为准。既有材料及第三方组件依其权利和许可证使用，不因交付自动转让全部知识产权。',
};
export const STANDARD_RULE_IDS=['acceptance','breach','tax','invoice','disputes','ip'] as const;
export type StandardRuleId=typeof STANDARD_RULE_IDS[number];
