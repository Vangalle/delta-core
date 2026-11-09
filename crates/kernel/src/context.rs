use crate::{KernelError, Workspace};
use delta_protocol::{Activity, Content, ContextQuote};

pub fn validate_quotes(quotes: &[ContextQuote]) -> Result<(), KernelError> {
    if quotes.len() > 16 || quotes.iter().map(|q| q.quote.len()).sum::<usize>() > 65_536 {
        return Err(KernelError::Invalid);
    }
    for quote in quotes {
        if quote.workspace_id.is_empty()
            || quote.workspace_id.len() > 128
            || quote.entry_id.is_empty()
            || quote.entry_id.len() > 128
            || quote.fragment.is_empty()
            || quote.fragment.len() > 256
            || quote.quote.trim().is_empty()
            || quote.quote.len() > 16_384
            || quote.revision == 0
            || quote.cursor == 0
        {
            return Err(KernelError::Invalid);
        }
    }
    Ok(())
}

pub fn validate_quote_source(
    source: &Workspace,
    cursor: u64,
    quote: &ContextQuote,
) -> Result<(), KernelError> {
    let entry = source.entry(&quote.entry_id)?;
    if quote.revision > entry.revision || quote.cursor > cursor {
        return Err(KernelError::Conflict);
    }
    let valid = match &entry.content {
        Content::Text { .. } => quote.fragment == "text",
        Content::Terminal { .. } => quote.fragment == "terminal",
        Content::Agent { activities, .. } => {
            if let Some(id) = quote.fragment.strip_prefix("message:") {
                activities.iter().any(|a| match a {
                    Activity::MessageStart { message_id }
                    | Activity::TextDelta { message_id, .. }
                    | Activity::MessageEnd { message_id, .. } => message_id == id,
                    _ => false,
                })
            } else if let Some(id) = quote.fragment.strip_prefix("tool:") {
                activities.iter().any(|a| match a {
                    Activity::ToolStart { call_id, .. }
                    | Activity::ToolUpdate { call_id, .. }
                    | Activity::ToolEnd { call_id, .. } => call_id == id,
                    _ => false,
                })
            } else if let Some(index) = quote
                .fragment
                .strip_prefix("prompt:")
                .and_then(|i| i.parse::<usize>().ok())
            {
                index
                    <= activities
                        .iter()
                        .filter(|a| matches!(a, Activity::Prompt { .. }))
                        .count()
            } else {
                false
            }
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(KernelError::Invalid)
    }
}
