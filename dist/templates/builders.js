/** Workflow connection that allows the model the user saved in Settings → Models. */
const CONNECTION = { mode: 'workspace', id: 'settings-default' };
const EXECUTION = { timeoutSeconds: 60, maxAttempts: 1 };
function workflow(id, name, description, inputSchema, nodes, edges) {
    return { apiVersion: 'jevable.ai/v1alpha1', kind: 'Workflow', metadata: { id: `template-${id}`, name, description },
        spec: { inputSchema, nodes, edges } };
}
/** A flat object schema whose listed fields are all required text or numbers, so Normal mode shows a plain form. */
function fields(properties) {
    return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, type === 'string' ? { type, minLength: 1, maxLength: 8000 } : { type }])) };
}
const named = ([title = '', description = '']) => ({ title, description });
const trigger = (label) => ({ type: 'trigger', ...named(label), config: { modes: ['manual'] } });
const output = (label, value) => ({ type: 'output', ...named(label), config: { value } });
const rule = (label, condition) => ({ type: 'rule', ...named(label), config: { mode: 'ifElse', condition } });
const cases = (label, value, ports) => ({ type: 'rule', ...named(label),
    config: { mode: 'switch', value, cases: ports.map(port => ({ value: port, port })) } });
const llm = (model, label, prompt, maxTokens = 800) => ({ type: 'llm', ...named(label),
    config: { provider: model.provider, model: model.model, connection: CONNECTION, prompt, responseFormat: 'text',
        generation: { maxTokens, stream: true }, execution: EXECUTION, historyScope: 'none' } });
const decision = (model, label, state, questions) => ({ type: 'decision',
    ...named(label), config: { provider: 'llm', model: model.model, llm: { provider: model.provider, generation: { maxTokens: 400, stream: true } },
        connection: CONNECTION, state, execution: EXECUTION, questions } });
const approval = (label, question, input, inputSchema) => ({ type: 'humanApproval', ...named(label),
    config: { title: question, input, inputSchema, actions: ['approve', 'reject'], expiresAfter: '24h', onReject: 'cancelled', onTimeout: 'expired' } });
/** Pick the English or Chinese variant of a piece of workflow content. */
const pick = (language, en, zh) => (language === 'zh' ? zh : en);
const supportReply = { id: 'support-reply', titleKey: 'templateSupportTitle', summaryKey: 'templateSupportSummary',
    basedOn: 'both', ai: true,
    sample: { en: { message: 'Hi, I was charged twice for order 1043. Can I get one payment back?' },
        zh: { message: '你好，订单 1043 被扣了两次款，可以退回一笔吗？' } },
    build: (language, title, model) => {
        const c = pick(language, {
            goal: 'Sort each customer message, ignore spam, and draft a reply in the customer\'s language that a person approves before it is sent.',
            start: ['Customer message', 'Starts with a message from a customer.'],
            sort: ['What kind of message?', 'The AI picks the kind of message: a question, a complaint, a refund request or spam.'],
            sortQuestion: 'What kind of customer message is this?',
            kinds: { question: 'A question about a product, an order or a service', complaint: 'The customer is unhappy and complains',
                refund: 'The customer asks for money back', spam: 'Advertising, scams or messages unrelated to the business' },
            route: ['Spam?', 'Spam ends here; every other message gets a reply draft.'],
            draft: ['Draft a reply', 'The AI writes a short, polite reply in the customer\'s language.'],
            prompt: 'You answer customer messages for a small business. The message is a ${{ nodes.sort.output.kind.choice }}. Write a short, '
                + 'polite reply in the same language as the customer. Do not promise refunds or dates; say a team member will confirm.\n\n'
                + 'Customer message: ${{ inputs.message }}',
            review: ['Approve the reply', 'A person reads the draft and approves it before it is sent.'], reviewQuestion: 'Send this reply?',
            sent: ['Send the reply', 'Returns the approved reply.'], spam: ['Ignore as spam', 'Returns a note that the message was ignored.'],
            spamValue: 'Ignored: the message looks like spam.',
        }, {
            goal: '为每条客户消息分类，忽略垃圾消息，并用客户的语言起草回复，经人工批准后再发送。',
            start: ['客户消息', '收到一条客户消息时开始。'],
            sort: ['这是什么消息？', 'AI 判断消息类型：咨询、投诉、退款或垃圾消息。'],
            sortQuestion: '这条客户消息属于哪一类？',
            kinds: { question: '咨询产品、订单或服务', complaint: '客户不满意并投诉', refund: '客户要求退款', spam: '广告、诈骗或与业务无关的消息' },
            route: ['是垃圾消息吗？', '垃圾消息到此结束，其他消息都会生成回复草稿。'],
            draft: ['起草回复', 'AI 用客户的语言写一段简短、礼貌的回复。'],
            prompt: '你是一家小企业的客服。这条消息的类型是：${{ nodes.sort.output.kind.choice }}。请用与客户相同的语言写一段简短、礼貌的回复。'
                + '不要承诺退款或具体日期，说明会由同事跟进确认。\n\n客户消息：${{ inputs.message }}',
            review: ['批准回复', '由人工阅读草稿，批准后才发送。'], reviewQuestion: '发送这条回复吗？',
            sent: ['发送回复', '返回已批准的回复。'], spam: ['作为垃圾消息忽略', '返回“已忽略”的说明。'],
            spamValue: '已忽略：这条消息看起来是垃圾消息。',
        });
        return workflow('support-reply', title, c.goal, fields({ message: 'string' }), {
            start: trigger(c.start),
            sort: decision(model, c.sort, '${{ inputs.message }}', { kind: { type: 'choice', instructions: c.sortQuestion, criteria: c.kinds } }),
            route: cases(c.route, '${{ nodes.sort.output.kind.choice }}', ['spam']),
            draft: llm(model, c.draft, c.prompt),
            review: approval(c.review, c.reviewQuestion, '${{ nodes.draft.output }}', { type: 'string' }),
            sent: output(c.sent, '${{ nodes.draft.output }}'),
            spam: output(c.spam, c.spamValue),
        }, [{ from: 'start', to: 'sort' }, { from: 'sort', to: 'route' }, { from: 'route', port: 'spam', to: 'spam' },
            { from: 'route', port: 'default', to: 'draft' }, { from: 'draft', to: 'review' }, { from: 'review', port: 'approve', to: 'sent' }]);
    } };
const socialPost = { id: 'social-post', titleKey: 'templateSocialTitle', summaryKey: 'templateSocialSummary',
    basedOn: 'coze', ai: true,
    sample: { en: { product: 'Handmade oolong tea from a small farm in Alishan, 150 g tin', audience: 'Office workers who like calm tea breaks' },
        zh: { product: '阿里山小农手作乌龙茶，150 克罐装', audience: '喜欢安静喝茶的上班族' } },
    build: (language, title, model) => {
        const c = pick(language, {
            goal: 'Turn a product description into a social media post (for example Xiaohongshu or Instagram), remove exaggerated claims, and let a person approve it.',
            start: ['Product details', 'Starts with the product and who it is for.'],
            write: ['Write the post', 'The AI writes three title ideas, the post and hashtags.'],
            writePrompt: 'Write a lively social media post (Xiaohongshu / Instagram style) about this product for ${{ inputs.audience }}. '
                + 'Give three short title ideas, a post of about 150 words with a few emoji, and 5 hashtags. Write in the same language as the '
                + 'product details.\n\nProduct: ${{ inputs.product }}',
            check: ['Remove exaggerated claims', 'The AI rewrites absolute or exaggerated claims, such as “the best” or “cures”, in calmer words.'],
            checkPrompt: 'Edit this post so it has no absolute, exaggerated or medical claims (for example “the best”, “number one”, “cures”, '
                + '“100%”). Keep the tone, language and length. Return only the edited post.\n\n${{ nodes.write.output }}',
            review: ['Approve the post', 'A person reads the post before it is published.'], reviewQuestion: 'Publish this post?',
            done: ['Post to publish', 'Returns the approved post.'],
        }, {
            goal: '把产品介绍变成一篇社交媒体笔记（例如小红书），删去夸大用语，并由人工批准后发布。',
            start: ['产品信息', '输入产品和目标人群后开始。'],
            write: ['撰写笔记', 'AI 写三个标题备选、正文和话题标签。'],
            writePrompt: '请为下面的产品写一篇小红书风格的种草笔记，目标读者是：${{ inputs.audience }}。给出三个吸引人的标题备选、约 200 字的正文'
                + '（适量使用表情符号），以及 5 个话题标签。使用与产品信息相同的语言。\n\n产品：${{ inputs.product }}',
            check: ['删去夸大用语', 'AI 把“最”“第一”“根治”等绝对化或夸大的用语改为平实的说法。'],
            checkPrompt: '请修改这篇笔记，删除所有绝对化、夸大或涉及疗效的用语（例如“最”“第一”“根治”“100%”），保持原有语气、语言和篇幅，'
                + '只返回修改后的笔记。\n\n${{ nodes.write.output }}',
            review: ['批准笔记', '发布前由人工阅读笔记。'], reviewQuestion: '发布这篇笔记吗？',
            done: ['待发布笔记', '返回已批准的笔记。'],
        });
        return workflow('social-post', title, c.goal, fields({ product: 'string', audience: 'string' }), {
            start: trigger(c.start),
            write: llm(model, c.write, c.writePrompt, 1200),
            check: llm(model, c.check, c.checkPrompt, 1200),
            review: approval(c.review, c.reviewQuestion, '${{ nodes.check.output }}', { type: 'string' }),
            done: output(c.done, '${{ nodes.check.output }}'),
        }, [{ from: 'start', to: 'write' }, { from: 'write', to: 'check' }, { from: 'check', to: 'review' },
            { from: 'review', port: 'approve', to: 'done' }]);
    } };
const leadQualifier = { id: 'lead-qualifier', titleKey: 'templateLeadTitle', summaryKey: 'templateLeadSummary',
    basedOn: 'n8n', ai: true,
    sample: { en: { enquiry: 'We are a 20-person clinic and need online booking before March. Who can I talk to about pricing?', budget: 8000 },
        zh: { enquiry: '我们是一家 20 人的诊所，希望 3 月前上线网上预约，请问价格方面找谁沟通？', budget: 8000 } },
    build: (language, title, model) => {
        const c = pick(language, {
            goal: 'Rate a sales enquiry: the AI checks that it is a real buying need, a rule sorts it by budget, and hot leads get a follow-up draft.',
            start: ['New enquiry', 'Starts with the enquiry text and the budget the customer gave.'],
            real: ['Real buying need?', 'The AI answers whether the enquiry describes a clear need to buy.'],
            realQuestion: 'Does this enquiry describe a clear need to buy, rather than general curiosity, a job application or spam?',
            realRule: ['Worth following up?', 'Continues when the AI is fairly sure the need is real.'],
            budgetRule: ['Budget 5,000 or more?', 'Larger budgets are hot leads; smaller ones are warm leads.'],
            follow: ['Draft a follow-up', 'The AI drafts a short follow-up message that proposes a call.'],
            followPrompt: 'Write a short, friendly follow-up to this sales enquiry in the same language. Thank them, repeat their need in one '
                + 'sentence and propose a 20-minute call this week.\n\nEnquiry: ${{ inputs.enquiry }}',
            hot: ['Hot lead', 'Returns the follow-up draft for a salesperson.'],
            warm: ['Warm lead', 'Returns a note to add the lead to the newsletter list.'], warmValue: 'Warm lead: add to the newsletter list.',
            cold: ['Not a lead', 'Returns a note that no follow-up is needed.'], coldValue: 'Not a sales lead: no follow-up needed.',
        }, {
            goal: '为销售询盘评级：AI 判断是否有真实购买需求，规则按预算分级，热门线索会得到跟进草稿。',
            start: ['新询盘', '输入询盘内容和客户给出的预算后开始。'],
            real: ['有真实购买需求吗？', 'AI 判断询盘是否描述了明确的购买需求。'],
            realQuestion: '这条询盘是否描述了明确的购买需求，而不是随便问问、求职或垃圾信息？',
            realRule: ['值得跟进吗？', 'AI 比较确定需求真实时继续。'],
            budgetRule: ['预算不少于 5,000？', '预算较高的是热门线索，较低的是温线索。'],
            follow: ['起草跟进消息', 'AI 起草一段简短的跟进消息，并约一次通话。'],
            followPrompt: '请用与询盘相同的语言，给这条销售询盘写一段简短、友好的跟进消息：感谢对方，用一句话复述需求，并提议本周进行一次 20 分钟的通话。'
                + '\n\n询盘：${{ inputs.enquiry }}',
            hot: ['热门线索', '返回给销售同事的跟进草稿。'],
            warm: ['温线索', '返回“加入资讯订阅名单”的说明。'], warmValue: '温线索：加入资讯订阅名单。',
            cold: ['不是销售线索', '返回“无需跟进”的说明。'], coldValue: '不是销售线索：无需跟进。',
        });
        return workflow('lead-qualifier', title, c.goal, fields({ enquiry: 'string', budget: 'number' }), {
            start: trigger(c.start),
            real: decision(model, c.real, '${{ inputs.enquiry }}', { buying: { type: 'noul', instructions: c.realQuestion } }),
            realRule: rule(c.realRule, '${{ nodes.real.output.buying.probability >= 0.6 }}'),
            budgetRule: rule(c.budgetRule, '${{ inputs.budget >= 5000 }}'),
            follow: llm(model, c.follow, c.followPrompt),
            hot: output(c.hot, '${{ nodes.follow.output }}'),
            warm: output(c.warm, c.warmValue),
            cold: output(c.cold, c.coldValue),
        }, [{ from: 'start', to: 'real' }, { from: 'real', to: 'realRule' }, { from: 'realRule', port: 'true', to: 'budgetRule' },
            { from: 'realRule', port: 'false', to: 'cold' }, { from: 'budgetRule', port: 'true', to: 'follow' },
            { from: 'budgetRule', port: 'false', to: 'warm' }, { from: 'follow', to: 'hot' }]);
    } };
const meetingActions = { id: 'meeting-actions', titleKey: 'templateMeetingTitle', summaryKey: 'templateMeetingSummary',
    basedOn: 'n8n', ai: true,
    sample: { en: { notes: 'Amy: the new menu launches on 1 May. Ben will print the flyers by Friday. We still need a photographer; Amy will ask two studios. Next meeting Tuesday.' },
        zh: { notes: '小美：新菜单 5 月 1 日上线。阿斌周五前把传单印好。还缺一位摄影师，小美去问两家工作室。下次会议周二。' } },
    build: (language, title, model) => {
        const c = pick(language, {
            goal: 'Turn meeting notes or a transcript into a short summary and a list of action items with owners and due dates.',
            start: ['Meeting notes', 'Starts with the notes or transcript of a meeting.'],
            summary: ['Summarize and list actions', 'The AI writes a short summary and lists every task with its owner and due date.'],
            prompt: 'Read these meeting notes. Write, in the same language: (1) a summary in three sentences, (2) a list of action items, each '
                + 'as “task — owner — due date” (write “to confirm” when the owner or date is missing), (3) open questions.\n\n${{ inputs.notes }}',
            done: ['Summary and actions', 'Returns the summary and the action list.'],
        }, {
            goal: '把会议记录或逐字稿整理成简短摘要，以及带负责人和截止日期的行动项清单。',
            start: ['会议记录', '输入会议记录或逐字稿后开始。'],
            summary: ['整理摘要和行动项', 'AI 写一段简短摘要，并列出每项任务的负责人和截止日期。'],
            prompt: '请阅读以下会议记录，并用相同的语言输出：(1) 三句话的会议摘要；(2) 行动项清单，每项写成“任务 — 负责人 — 截止日期”'
                + '（缺少负责人或日期时写“待确认”）；(3) 尚未解决的问题。\n\n${{ inputs.notes }}',
            done: ['摘要与行动项', '返回摘要和行动项清单。'],
        });
        return workflow('meeting-actions', title, c.goal, fields({ notes: 'string' }), {
            start: trigger(c.start), summary: llm(model, c.summary, c.prompt, 1200), done: output(c.done, '${{ nodes.summary.output }}'),
        }, [{ from: 'start', to: 'summary' }, { from: 'summary', to: 'done' }]);
    } };
const reviewReply = { id: 'review-reply', titleKey: 'templateReviewTitle', summaryKey: 'templateReviewSummary',
    basedOn: 'both', ai: true,
    sample: { en: { review: 'The cake tasted great but it arrived two hours late and the box was crushed.' },
        zh: { review: '蛋糕味道很好，但晚到了两个小时，盒子也被压坏了。' } },
    build: (language, title, model) => {
        const c = pick(language, {
            goal: 'Read a customer review, sort it as positive, neutral or negative, and draft a reply: negative reviews get an apology a person approves.',
            start: ['Customer review', 'Starts with the text of one review.'],
            mood: ['How does the customer feel?', 'The AI sorts the review as positive, neutral or negative.'],
            moodQuestion: 'How does the customer feel overall in this review?',
            moods: { positive: 'Happy or satisfied', neutral: 'Mixed or only factual', negative: 'Unhappy, disappointed or angry' },
            route: ['Which feeling?', 'Negative reviews get an apology, positive ones a thank-you, neutral ones no reply.'],
            sorry: ['Draft an apology', 'The AI drafts a sincere apology that names the problem.'],
            sorryPrompt: 'Write a short, sincere public reply to this unhappy review in the same language. Name the problem, apologise, and '
                + 'invite the customer to message us so we can make it right. No excuses.\n\nReview: ${{ inputs.review }}',
            review: ['Approve the apology', 'A person checks the apology before it is posted.'], reviewQuestion: 'Post this reply?',
            sorryDone: ['Apology to post', 'Returns the approved apology.'],
            thanks: ['Draft a thank-you', 'The AI drafts a short thank-you.'],
            thanksPrompt: 'Write a warm two-sentence thank-you reply to this review in the same language.\n\nReview: ${{ inputs.review }}',
            thanksDone: ['Thank-you to post', 'Returns the thank-you reply.'],
            neutral: ['No reply needed', 'Returns a note that the review needs no reply.'], neutralValue: 'Neutral review: no reply needed.',
        }, {
            goal: '阅读客户评价，分为正面、中性或负面并起草回复：负面评价会得到一份由人工批准的致歉回复。',
            start: ['客户评价', '输入一条评价内容后开始。'],
            mood: ['客户感受如何？', 'AI 把评价分为正面、中性或负面。'],
            moodQuestion: '这条评价整体上表达了客户怎样的感受？',
            moods: { positive: '满意或开心', neutral: '好坏参半或只陈述事实', negative: '不满、失望或生气' },
            route: ['哪种感受？', '负面评价致歉，正面评价致谢，中性评价无需回复。'],
            sorry: ['起草致歉回复', 'AI 起草一段真诚的致歉，并点明问题。'],
            sorryPrompt: '请用与评价相同的语言，为这条差评写一段简短、真诚的公开回复：点明问题、表示歉意，并邀请客户私信我们以便补救。不要找借口。'
                + '\n\n评价：${{ inputs.review }}',
            review: ['批准致歉回复', '发布前由人工检查致歉内容。'], reviewQuestion: '发布这条回复吗？',
            sorryDone: ['待发布的致歉', '返回已批准的致歉回复。'],
            thanks: ['起草感谢回复', 'AI 起草一段简短的感谢。'],
            thanksPrompt: '请用与评价相同的语言，为这条评价写两句温暖的感谢回复。\n\n评价：${{ inputs.review }}',
            thanksDone: ['待发布的感谢', '返回感谢回复。'],
            neutral: ['无需回复', '返回“无需回复”的说明。'], neutralValue: '中性评价：无需回复。',
        });
        return workflow('review-reply', title, c.goal, fields({ review: 'string' }), {
            start: trigger(c.start),
            mood: decision(model, c.mood, '${{ inputs.review }}', { feeling: { type: 'choice', instructions: c.moodQuestion, criteria: c.moods } }),
            route: cases(c.route, '${{ nodes.mood.output.feeling.choice }}', ['negative', 'positive']),
            sorry: llm(model, c.sorry, c.sorryPrompt),
            review: approval(c.review, c.reviewQuestion, '${{ nodes.sorry.output }}', { type: 'string' }),
            sorryDone: output(c.sorryDone, '${{ nodes.sorry.output }}'),
            thanks: llm(model, c.thanks, c.thanksPrompt, 300),
            thanksDone: output(c.thanksDone, '${{ nodes.thanks.output }}'),
            neutral: output(c.neutral, c.neutralValue),
        }, [{ from: 'start', to: 'mood' }, { from: 'mood', to: 'route' }, { from: 'route', port: 'negative', to: 'sorry' },
            { from: 'route', port: 'positive', to: 'thanks' }, { from: 'route', port: 'default', to: 'neutral' }, { from: 'sorry', to: 'review' },
            { from: 'review', port: 'approve', to: 'sorryDone' }, { from: 'thanks', to: 'thanksDone' }]);
    } };
const resumeScreen = { id: 'resume-screen', titleKey: 'templateResumeTitle', summaryKey: 'templateResumeSummary',
    basedOn: 'both', ai: true,
    sample: { en: { job: 'Shop assistant: retail experience, fluent Cantonese and English, weekend shifts.',
            resume: 'Two years at a bakery counter in Mong Kok. Speaks Cantonese, English and some Mandarin. Available on weekends.' },
        zh: { job: '门店店员：有零售经验，普通话和英语流利，可上周末班。', resume: '在面包店做过两年收银和导购，会说普通话、英语和粤语，周末可以上班。' } },
    build: (language, title, model) => {
        const c = pick(language, {
            goal: 'Check a resume against a job description: likely matches get an interview invitation that a person approves; the rest are kept for review.',
            start: ['Job and resume', 'Starts with the job description and the resume text.'],
            match: ['Meets the must-haves?', 'The AI answers whether the resume shows every must-have in the job description.'],
            matchQuestion: 'Does the resume show clear evidence of every must-have requirement in the job description?',
            matchRule: ['Likely match?', 'Continues to an invitation when the AI is fairly sure.'],
            invite: ['Draft an invitation', 'The AI drafts a short interview invitation that names the strengths it saw.'],
            invitePrompt: 'Write a short interview invitation email in the same language as the resume. Mention two strengths from the resume '
                + 'that fit the job, and ask for two time slots next week.\n\nJob: ${{ inputs.job }}\n\nResume: ${{ inputs.resume }}',
            review: ['HR approves', 'A person approves the invitation before it is sent.'], reviewQuestion: 'Send this interview invitation?',
            invited: ['Invitation to send', 'Returns the approved invitation.'],
            hold: ['Keep for review', 'Returns a note that a person reviews this resume.'],
            holdValue: 'Not a clear match: a person reviews this resume. No email is sent.',
        }, {
            goal: '对照职位要求检查简历：可能匹配的候选人会得到一封由人工批准的面试邀请，其余简历留待人工查看。',
            start: ['职位与简历', '输入职位描述和简历内容后开始。'],
            match: ['满足必备条件吗？', 'AI 判断简历是否体现了职位描述中的所有必备条件。'],
            matchQuestion: '简历是否清楚体现了职位描述中的每一项必备条件？',
            matchRule: ['可能匹配吗？', 'AI 比较确定时，进入面试邀请。'],
            invite: ['起草面试邀请', 'AI 起草一封简短的面试邀请，并写出看到的优势。'],
            invitePrompt: '请用与简历相同的语言写一封简短的面试邀请邮件：提到简历中两项与职位相符的优势，并请对方提供下周的两个可面试时段。'
                + '\n\n职位：${{ inputs.job }}\n\n简历：${{ inputs.resume }}',
            review: ['HR 批准', '发送前由人工批准面试邀请。'], reviewQuestion: '发送这封面试邀请吗？',
            invited: ['待发送的邀请', '返回已批准的面试邀请。'],
            hold: ['留待人工查看', '返回“由人工查看这份简历”的说明。'], holdValue: '匹配度不明确：由人工查看这份简历，不会发送邮件。',
        });
        return workflow('resume-screen', title, c.goal, fields({ job: 'string', resume: 'string' }), {
            start: trigger(c.start),
            match: decision(model, c.match, 'Job: ${{ inputs.job }}\n\nResume: ${{ inputs.resume }}', { fit: { type: 'noul', instructions: c.matchQuestion } }),
            matchRule: rule(c.matchRule, '${{ nodes.match.output.fit.probability >= 0.7 }}'),
            invite: llm(model, c.invite, c.invitePrompt),
            review: approval(c.review, c.reviewQuestion, '${{ nodes.invite.output }}', { type: 'string' }),
            invited: output(c.invited, '${{ nodes.invite.output }}'),
            hold: output(c.hold, c.holdValue),
        }, [{ from: 'start', to: 'match' }, { from: 'match', to: 'matchRule' }, { from: 'matchRule', port: 'true', to: 'invite' },
            { from: 'matchRule', port: 'false', to: 'hold' }, { from: 'invite', to: 'review' }, { from: 'review', port: 'approve', to: 'invited' }]);
    } };
const expenseCheck = { id: 'expense-check', titleKey: 'templateExpenseTitle', summaryKey: 'templateExpenseSummary',
    basedOn: 'n8n', ai: false,
    sample: { en: { total: 6200, items: [{ amount: 480, receipt: true }, { amount: 5720, receipt: false }] },
        zh: { total: 6200, items: [{ amount: 480, receipt: true }, { amount: 5720, receipt: false }] } },
    build: (language, title) => {
        const c = pick(language, {
            goal: 'Check an expense claim without AI: every item needs a receipt and must be 1,000 or less, and claims over 5,000 need a manager.',
            start: ['Expense claim', 'Starts with the claim total and its items (amount and whether there is a receipt).'],
            each: ['Check every item', 'Repeats the item check once for each item in the claim.'],
            item: ['Receipt and within limit?', 'An item is fine when it has a receipt and is 1,000 or less.'],
            ok: 'OK', flag: 'Check this item: missing receipt or over 1,000',
            large: ['Over 5,000?', 'Claims over 5,000 go to a manager.'],
            review: ['Manager approves', 'A manager reads the item checks and approves the claim.'], reviewQuestion: 'Approve this expense claim?',
            approved: ['Approved by the manager', 'Returns the item checks of the approved claim.'],
            small: ['Item checks', 'Returns the check result of every item.'],
        }, {
            goal: '不用 AI 检查报销单：每项都要有收据且不超过 1,000，总额超过 5,000 的报销单需要经理批准。',
            start: ['报销单', '输入报销总额和各项明细（金额、是否有收据）后开始。'],
            each: ['逐项检查', '对报销单中的每一项重复一次检查。'],
            item: ['有收据且未超限？', '有收据且金额不超过 1,000 的项目视为合格。'],
            ok: '合格', flag: '请核查此项：缺少收据或超过 1,000',
            large: ['总额超过 5,000？', '总额超过 5,000 的报销单交给经理。'],
            review: ['经理批准', '经理查看逐项检查结果并批准报销单。'], reviewQuestion: '批准这张报销单吗？',
            approved: ['经理已批准', '返回已批准报销单的逐项检查结果。'],
            small: ['逐项检查结果', '返回每一项的检查结果。'],
        });
        const results = '${{ nodes.each.output.results }}';
        return workflow('expense-check', title, c.goal, { type: 'object', additionalProperties: false, required: ['total', 'items'], properties: {
                total: { type: 'number', minimum: 0 }, items: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false,
                        required: ['amount', 'receipt'], properties: { amount: { type: 'number', minimum: 0 }, receipt: { type: 'boolean' } } } }
            } }, {
            start: trigger(c.start),
            each: { type: 'loop', ...named(c.each), config: { mode: 'forEach', items: '${{ inputs.items }}', maxIterations: 50, timeoutSeconds: 60,
                    body: { entry: 'item', nodes: { item: rule(c.item, '${{ loop.item.receipt && loop.item.amount <= 1000 }}') }, edges: [],
                        exits: [{ from: 'item', port: 'true', result: c.ok }, { from: 'item', port: 'false', result: c.flag }] } } },
            large: rule(c.large, '${{ inputs.total > 5000 }}'),
            review: approval(c.review, c.reviewQuestion, results, { type: 'array', items: { type: 'string' } }),
            approved: output(c.approved, results),
            small: output(c.small, results),
        }, [{ from: 'start', to: 'each' }, { from: 'each', port: 'done', to: 'large' }, { from: 'large', port: 'true', to: 'review' },
            { from: 'large', port: 'false', to: 'small' }, { from: 'review', port: 'approve', to: 'approved' }]);
    } };
const discountApproval = { id: 'discount-approval', titleKey: 'templateDiscountTitle', summaryKey: 'templateDiscountSummary',
    basedOn: 'n8n', ai: false,
    sample: { en: { customer: 'Harbour Café', discount: 12 }, zh: { customer: '海港咖啡', discount: 12 } },
    build: (language, title) => {
        const c = pick(language, {
            goal: 'Approve quote discounts without AI: up to 5% is approved at once, up to 15% needs a manager, and more is refused.',
            start: ['Quote discount', 'Starts with the customer and the discount in percent.'],
            small: ['5% or less?', 'Small discounts are approved at once.'],
            medium: ['15% or less?', 'Discounts up to 15% go to a manager; larger ones are refused.'],
            review: ['Manager approves', 'A manager approves the discount.'], reviewQuestion: 'Approve this discount (percent)?',
            auto: ['Approved at once', 'Returns that the discount is approved.'], autoValue: 'Approved: the discount is within 5%.',
            manager: ['Approved by the manager', 'Returns that the manager approved the discount.'], managerValue: 'Approved by the manager.',
            refused: ['Refused', 'Returns that the discount is too large.'], refusedValue: 'Refused: discounts over 15% need a new quote.',
        }, {
            goal: '不用 AI 审批报价折扣：5% 以内直接通过，15% 以内由经理批准，超过则拒绝。',
            start: ['报价折扣', '输入客户和折扣百分比后开始。'],
            small: ['不超过 5%？', '小额折扣直接通过。'],
            medium: ['不超过 15%？', '15% 以内的折扣交给经理，超过则拒绝。'],
            review: ['经理批准', '由经理批准这个折扣。'], reviewQuestion: '批准这个折扣（百分比）吗？',
            auto: ['直接通过', '返回“折扣已通过”。'], autoValue: '已通过：折扣在 5% 以内。',
            manager: ['经理已批准', '返回“经理已批准折扣”。'], managerValue: '经理已批准。',
            refused: ['已拒绝', '返回“折扣过大”。'], refusedValue: '已拒绝：超过 15% 的折扣需要重新报价。',
        });
        return workflow('discount-approval', title, c.goal, fields({ customer: 'string', discount: 'number' }), {
            start: trigger(c.start),
            small: rule(c.small, '${{ inputs.discount <= 5 }}'),
            medium: rule(c.medium, '${{ inputs.discount <= 15 }}'),
            review: approval(c.review, c.reviewQuestion, '${{ inputs.discount }}', { type: 'number' }),
            auto: output(c.auto, c.autoValue),
            manager: output(c.manager, c.managerValue),
            refused: output(c.refused, c.refusedValue),
        }, [{ from: 'start', to: 'small' }, { from: 'small', port: 'true', to: 'auto' }, { from: 'small', port: 'false', to: 'medium' },
            { from: 'medium', port: 'true', to: 'review' }, { from: 'medium', port: 'false', to: 'refused' },
            { from: 'review', port: 'approve', to: 'manager' }]);
    } };
const translate = { id: 'translate', titleKey: 'templateTranslateTitle', summaryKey: 'templateTranslateSummary',
    basedOn: 'n8n', ai: true,
    sample: { en: { text: 'Our shop is closed on public holidays. Online orders still ship the next working day.', target: 'Traditional Chinese (Hong Kong)' },
        zh: { text: 'Our shop is closed on public holidays. Online orders still ship the next working day.', target: '繁体中文（台湾）' } },
    build: (language, title, model) => {
        const c = pick(language, {
            goal: 'Translate text with local wording (for example Hong Kong, Taiwan or mainland Chinese), then let the AI check the meaning; unsure translations go to a person.',
            start: ['Text to translate', 'Starts with the text and the target language, such as “Traditional Chinese (Taiwan)”.'],
            translate: ['Translate', 'The AI translates using the everyday words of the target region.'],
            prompt: 'Translate the text into ${{ inputs.target }}. Use the everyday vocabulary and punctuation of that region (for example '
                + '軟件 in Hong Kong but 軟體 in Taiwan). Keep names, numbers and formatting. Return only the translation.\n\n${{ inputs.text }}',
            check: ['Same meaning?', 'The AI checks that the translation keeps the full meaning.'],
            checkQuestion: 'Does the translation keep the full meaning of the original, with nothing added or missing?',
            checkRule: ['Sure enough?', 'Clear translations are done; unsure ones go to a person.'],
            review: ['A person checks', 'A person checks the translation.'], reviewQuestion: 'Use this translation?',
            checked: ['Checked translation', 'Returns the translation a person approved.'],
            done: ['Translation', 'Returns the translation.'],
        }, {
            goal: '按当地用语翻译文字（例如香港、台湾或内地的中文），再由 AI 检查意思是否一致；不确定的译文交给人工。',
            start: ['待翻译文字', '输入文字和目标语言（例如“繁体中文（台湾）”）后开始。'],
            translate: ['翻译', 'AI 使用目标地区的日常用语进行翻译。'],
            prompt: '请把下面的文字翻译成${{ inputs.target }}。使用该地区的日常用语和标点（例如香港用“軟件”、台湾用“軟體”），保留人名、数字和格式，'
                + '只返回译文。\n\n${{ inputs.text }}',
            check: ['意思一致吗？', 'AI 检查译文是否完整保留原意。'],
            checkQuestion: '译文是否完整保留了原文的意思，没有增加或遗漏？',
            checkRule: ['够确定吗？', '清楚的译文直接完成；不确定的交给人工。'],
            review: ['人工检查', '由人工检查译文。'], reviewQuestion: '使用这份译文吗？',
            checked: ['已检查的译文', '返回人工批准的译文。'],
            done: ['译文', '返回译文。'],
        });
        return workflow('translate', title, c.goal, fields({ text: 'string', target: 'string' }), {
            start: trigger(c.start),
            translate: llm(model, c.translate, c.prompt, 1500),
            check: decision(model, c.check, 'Original: ${{ inputs.text }}\n\nTranslation: ${{ nodes.translate.output }}', { same: { type: 'noul', instructions: c.checkQuestion } }),
            checkRule: rule(c.checkRule, '${{ nodes.check.output.same.probability >= 0.8 }}'),
            review: approval(c.review, c.reviewQuestion, '${{ nodes.translate.output }}', { type: 'string' }),
            checked: output(c.checked, '${{ nodes.translate.output }}'),
            done: output(c.done, '${{ nodes.translate.output }}'),
        }, [{ from: 'start', to: 'translate' }, { from: 'translate', to: 'check' }, { from: 'check', to: 'checkRule' },
            { from: 'checkRule', port: 'true', to: 'done' }, { from: 'checkRule', port: 'false', to: 'review' },
            { from: 'review', port: 'approve', to: 'checked' }]);
    } };
const faqAnswer = { id: 'faq-answer', titleKey: 'templateFaqTitle', summaryKey: 'templateFaqSummary',
    basedOn: 'coze', ai: true,
    sample: { en: { policy: 'Returns: unopened items within 14 days with a receipt. Refunds go back to the original card within 7 working days. Sale items cannot be returned.',
            question: 'I bought shoes on sale last week. Can I return them?' },
        zh: { policy: '退货：未拆封商品凭收据 14 天内可退。退款在 7 个工作日内退回原支付方式。特价商品不设退货。', question: '我上周买了特价鞋，可以退吗？' } },
    build: (language, title, model) => {
        const c = pick(language, {
            goal: 'Answer a customer question only from the policy text you paste in; when the text does not cover it, hand the question to a person.',
            start: ['Policy and question', 'Starts with your policy or FAQ text and the customer question.'],
            covered: ['Does the policy answer it?', 'The AI checks whether the pasted text contains the answer.'],
            coveredQuestion: 'Does the policy text contain the answer to the customer question?',
            coveredRule: ['Answer found?', 'Found answers are written up; the rest go to a person.'],
            answer: ['Write the answer', 'The AI answers using only the policy text and quotes the rule it used.'],
            prompt: 'Answer the customer question using only the policy below, in the same language as the question. Quote the sentence of the '
                + 'policy you relied on. Do not add anything the policy does not say.\n\nPolicy: ${{ inputs.policy }}\n\nQuestion: ${{ inputs.question }}',
            done: ['Answer', 'Returns the answer.'],
            person: ['Hand to a person', 'Returns a note that a person answers this question.'],
            personValue: 'The policy does not cover this question: a team member will answer.',
        }, {
            goal: '只根据你粘贴的政策文字回答客户问题；文字没有涵盖的问题交给人工处理。',
            start: ['政策与问题', '输入政策或常见问题文字，以及客户的问题后开始。'],
            covered: ['政策里有答案吗？', 'AI 检查粘贴的文字是否包含答案。'],
            coveredQuestion: '政策文字中是否包含这个客户问题的答案？',
            coveredRule: ['找到答案了吗？', '找到答案就作答，否则交给人工。'],
            answer: ['撰写答复', 'AI 只依据政策文字作答，并引用所依据的条款。'],
            prompt: '请只依据下面的政策，用与问题相同的语言回答客户问题，并引用你所依据的政策原句。不要补充政策中没有的内容。'
                + '\n\n政策：${{ inputs.policy }}\n\n问题：${{ inputs.question }}',
            done: ['答复', '返回答复。'],
            person: ['转人工', '返回“由人工回答”的说明。'], personValue: '政策中没有涵盖这个问题：将由同事回答。',
        });
        return workflow('faq-answer', title, c.goal, fields({ policy: 'string', question: 'string' }), {
            start: trigger(c.start),
            covered: decision(model, c.covered, 'Policy: ${{ inputs.policy }}\n\nQuestion: ${{ inputs.question }}', { answered: { type: 'noul', instructions: c.coveredQuestion } }),
            coveredRule: rule(c.coveredRule, '${{ nodes.covered.output.answered.probability >= 0.6 }}'),
            answer: llm(model, c.answer, c.prompt),
            done: output(c.done, '${{ nodes.answer.output }}'),
            person: output(c.person, c.personValue),
        }, [{ from: 'start', to: 'covered' }, { from: 'covered', to: 'coveredRule' }, { from: 'coveredRule', port: 'true', to: 'answer' },
            { from: 'coveredRule', port: 'false', to: 'person' }, { from: 'answer', to: 'done' }]);
    } };
/** Templates in the order the gallery shows them: the most popular ideas first, the no-AI ones last. */
export const WORKFLOW_TEMPLATES = [supportReply, socialPost, leadQualifier, meetingActions, reviewReply,
    resumeScreen, faqAnswer, translate, expenseCheck, discountApproval];
