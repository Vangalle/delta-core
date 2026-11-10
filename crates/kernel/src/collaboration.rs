use crate::{Decision, KernelError, Workspace};
use delta_protocol::*;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

fn mask_backslash_math(text: &str) -> String {
    let mut masked = text.as_bytes().to_vec();
    for (open, close) in [("\\(", "\\)"), ("\\[", "\\]")] {
        let mut from = 0;
        while let Some(start) = text[from..].find(open).map(|index| from + index) {
            let body = start + open.len();
            let Some(end) = text[body..]
                .find(close)
                .map(|index| body + index + close.len())
            else {
                break;
            };
            masked[start..end].fill(b' ');
            from = end;
        }
    }
    String::from_utf8(masked).expect("math delimiters are UTF-8 boundaries")
}

fn bare_url_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut finder = linkify::LinkFinder::new();
    finder.url_must_have_scheme(false);
    let mut ranges = finder
        .links(text)
        .map(|link| link.start()..link.end())
        .collect::<Vec<_>>();
    let mut offset = 0;
    for token in text.split_whitespace() {
        let start = offset + text[offset..].find(token).unwrap_or(0);
        offset = start + token.len();
        let canonical_mention = token.trim_start_matches(['(', '{']).starts_with("[@");
        let uri = !canonical_mention
            && (token.contains("://")
                || token.to_ascii_lowercase().contains("www.")
                || token.split(['(', '[', '{', '<', '\"', '\'']).any(|part| {
                    part.split_once(':').is_some_and(|(scheme, _)| {
                        !scheme.starts_with("delta-")
                            && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                            && scheme
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
                    })
                }));
        if uri {
            ranges.push(start..offset);
        }
    }
    ranges.sort_unstable_by_key(|range| range.start);
    let mut merged: Vec<std::ops::Range<usize>> = Vec::new();
    for range in ranges {
        if let Some(previous) = merged.last_mut()
            && previous.end >= range.start
        {
            previous.end = previous.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    merged
}

pub fn parse_mentions(text: &str, backend: &str) -> Vec<Mention> {
    let urls = bare_url_ranges(text);
    let masked = mask_backslash_math(text);
    let mut mentions = Vec::new();
    let mut excluded = 0usize;
    let mut links = 0usize;
    let mut pending: Option<Mention> = None;
    for (event, range) in Parser::new_ext(&masked, Options::ENABLE_MATH).into_offset_iter() {
        match event {
            Event::InlineHtml(html) => {
                let html = html.trim().to_ascii_lowercase();
                let closing = html.starts_with("</");
                let name = html
                    .trim_start_matches('<')
                    .trim_start_matches('/')
                    .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
                    .next()
                    .unwrap_or("");
                if matches!(name, "code" | "pre" | "a" | "script" | "style" | "textarea") {
                    if closing {
                        excluded = excluded.saturating_sub(1);
                    } else if !html.ends_with("/>") {
                        excluded += 1;
                    }
                }
            }
            Event::Start(Tag::CodeBlock(_) | Tag::BlockQuote(_)) => excluded += 1,
            Event::End(TagEnd::CodeBlock | TagEnd::BlockQuote(_)) => {
                excluded = excluded.saturating_sub(1)
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                links += 1;
                let url = urls
                    .get(urls.partition_point(|url| url.end <= range.start))
                    .is_some_and(|url| url.contains(&range.start));
                if excluded == 0 && !url {
                    let target = dest_url
                        .strip_prefix("delta-user:")
                        .map(|id| (MentionKind::User, id))
                        .or_else(|| {
                            dest_url
                                .strip_prefix("delta-agent:")
                                .map(|id| (MentionKind::Agent, id))
                        })
                        .or_else(|| {
                            dest_url
                                .strip_prefix("delta-thread:")
                                .map(|id| (MentionKind::Thread, id))
                        });
                    if let Some((kind, target)) =
                        target.filter(|(_, id)| !id.is_empty() && id.len() <= 128)
                    {
                        pending = Some(Mention {
                            kind,
                            target: target.into(),
                            label: String::new(),
                        });
                    }
                }
            }
            Event::End(TagEnd::Link) => {
                links = links.saturating_sub(1);
                if let Some(mention) = pending.take()
                    && !mentions.contains(&mention)
                {
                    mentions.push(mention);
                }
            }
            Event::Text(label) if pending.is_some() => {
                pending.as_mut().unwrap().label.push_str(&label)
            }
            Event::Text(_) if excluded == 0 && links == 0 => {
                let offset = range.start;
                let raw = &masked[range];
                for (index, _) in raw.match_indices("@agent") {
                    let before = raw[..index].chars().next_back();
                    let after = raw[index + 6..].chars().next();
                    let start = before.is_none_or(|c| c.is_whitespace() || "([{“\"".contains(c));
                    let end =
                        after.is_none_or(|c| c.is_whitespace() || ")]}.,!?;:，。！？".contains(c));
                    let domain = raw[index + 6..].starts_with('.')
                        && raw[index + 7..]
                            .chars()
                            .next()
                            .is_some_and(char::is_alphanumeric);
                    let escaped = text[..offset + index].ends_with('\\');
                    let position = offset + index;
                    let url = urls
                        .get(urls.partition_point(|range| range.end <= position))
                        .is_some_and(|range| range.contains(&position));
                    if start && end && !domain && !escaped && !url {
                        let mention = Mention {
                            kind: MentionKind::Agent,
                            target: backend.into(),
                            label: "@agent".into(),
                        };
                        if !mentions.contains(&mention) {
                            mentions.push(mention);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    mentions
}

impl Workspace {
    pub(super) fn join(&self, actor: &Member) -> Decision {
        let mut participants = self.collaboration.participants.clone();
        let mut changes = Vec::new();
        for id in self
            .entries
            .iter()
            .map(|entry| &entry.author)
            .chain(std::iter::once(&actor.id))
        {
            if !participants.contains(id) {
                participants.push(id.clone());
                changes.push(Change::ParticipantJoined { member: id.clone() });
            }
        }
        if participants.len() >= 2
            && !self.collaboration.mode_explicit
            && self.collaboration.reply_mode == ReplyMode::Auto
        {
            changes.push(Change::ReplyModeChanged {
                mode: ReplyMode::MentionsOnly,
                explicit: false,
            });
        }
        Decision {
            changes,
            effect: None,
        }
    }

    pub(super) fn submit(
        &self,
        actor: &Member,
        id: String,
        text: String,
        _after: Option<String>,
        quotes: Vec<ContextQuote>,
        backend: String,
    ) -> Result<Decision, KernelError> {
        if id.len() > 120
            || text.len() > 262_144
            || (text.trim().is_empty() && quotes.is_empty())
            || backend.is_empty()
            || backend.len() > 128
        {
            return Err(KernelError::Invalid);
        }
        let mut decision = self.join(actor);
        let reply_mode = decision
            .changes
            .iter()
            .rev()
            .find_map(|change| match change {
                Change::ReplyModeChanged { mode, .. } => Some(*mode),
                _ => None,
            })
            .unwrap_or(self.collaboration.reply_mode);
        let mut publication = self.decide(
            actor,
            Command::PublishText {
                id: id.clone(),
                base_revision: 0,
                text: text.clone(),
                after: None,
                quotes: quotes.clone(),
            },
        )?;
        let mentions = parse_mentions(&text, &backend);
        if let Some(Change::Inserted { entry, .. }) = publication.changes.first_mut() {
            entry.mentions = mentions.clone();
        }
        decision.changes.extend(publication.changes);
        let requested = mentions
            .iter()
            .any(|m| m.kind == MentionKind::Agent && m.target == backend);
        if actor.role.can_execute() && (reply_mode == ReplyMode::Auto || requested) {
            let agent_id = format!("{id}:agent");
            if self.entry(&agent_id).is_ok() {
                return Err(KernelError::Conflict);
            }
            let prompt = if text.trim().is_empty() {
                "Consider the quoted excerpts.".into()
            } else {
                text
            };
            let mut reply = self.decide(
                actor,
                Command::PromptAgent {
                    id: agent_id,
                    backend,
                    prompt,
                    after: None,
                    quotes,
                },
            )?;
            if let Some(Change::Inserted { entry, after }) = reply.changes.first_mut() {
                *after = Some(id.clone());
                if let Content::Agent { source_entry, .. } = &mut entry.content {
                    *source_entry = Some(id);
                }
                entry.quotes.clear();
            }
            decision.changes.extend(reply.changes);
            decision.effect = reply.effect;
        }
        Ok(decision)
    }
}
