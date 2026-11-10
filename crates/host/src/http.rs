use crate::{Service, ServiceError};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event as SseEvent, KeepAlive},
    },
    routing::{get, post},
};
use delta_protocol::*;
use serde::Deserialize;
use std::{convert::Infallible, path::PathBuf};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "A valid member token is required",
            ),
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                "forbidden",
                "This member cannot perform that action",
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "Workspace, reference or entry not found",
            ),
            Self::Conflict => (
                StatusCode::CONFLICT,
                "conflict",
                "The shared content changed. Your local draft must be reconciled before publishing",
            ),
            Self::MembershipConflict => (
                StatusCode::CONFLICT,
                "membership_exists",
                "This account is already a member with a different role; adding a friend does not change existing permissions",
            ),
            Self::Invalid => (
                StatusCode::BAD_REQUEST,
                "invalid_command",
                "Invalid command, target or backend",
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "The execution session is unavailable",
            ),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Host persistence or execution failed",
            ),
        };
        (
            status,
            Json(ApiError {
                code: code.into(),
                message: message.into(),
            }),
        )
            .into_response()
    }
}

async fn member(service: &Service, headers: &HeaderMap) -> Result<Member, ServiceError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(ServiceError::Unauthorized)?;
    service.authenticate(token).await
}

pub fn router(service: Service, assets: Option<PathBuf>) -> Router {
    let mut router = Router::new()
        .route("/api/v1/me", get(me))
        .route(
            "/api/v1/workspaces/{id}/members",
            get(members).post(add_friend),
        )
        .route("/api/v1/workspaces/{id}/invitations", post(invite))
        .route("/api/v1/invitations/{token}", get(invitation_preview))
        .route("/api/v1/invitations/accept", post(accept_invitation))
        .route("/api/v1/friends", get(friends))
        .route("/api/v1/friends/request", post(request_friend))
        .route("/api/v1/friends/accept", post(accept_friend))
        .route("/api/v1/backends", get(backends))
        .route("/api/v1/workspaces", get(workspaces).post(create_workspace))
        .route("/api/v1/workspaces/{id}", get(snapshot))
        .route("/api/v1/workspaces/{id}/commands", post(command))
        .route("/api/v1/workspaces/{id}/events", get(events))
        .layer(DefaultBodyLimit::max(524_288))
        .with_state(service);
    if let Some(path) = assets {
        router = router.fallback_service(
            ServeDir::new(&path).not_found_service(ServeFile::new(path.join("index.html"))),
        );
    }
    router
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store")))
        .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS,header::HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY,header::HeaderValue::from_static("no-referrer")))
        .layer(SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY,header::HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")))
}

async fn me(State(s): State<Service>, headers: HeaderMap) -> Result<Json<Member>, ServiceError> {
    Ok(Json(member(&s, &headers).await?))
}
async fn members(
    State(s): State<Service>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Vec<Member>>, ServiceError> {
    let actor = member(&s, &headers).await?;
    Ok(Json(s.members(&actor, &id).await?))
}
async fn invite(
    State(s): State<Service>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<InviteMember>,
) -> Result<Json<WorkspaceInvitation>, ServiceError> {
    let actor = member(&s, &headers).await?;
    Ok(Json(s.create_invitation(&actor, &id, body).await?))
}
async fn invitation_preview(
    State(s): State<Service>,
    Path(token): Path<String>,
) -> Result<Json<InvitationPreview>, ServiceError> {
    Ok(Json(s.invitation_preview(&token).await?))
}
async fn accept_invitation(
    State(s): State<Service>,
    headers: HeaderMap,
    Json(body): Json<AcceptInvitation>,
) -> Result<Json<AcceptedInvitation>, ServiceError> {
    let actor = if headers.contains_key(header::AUTHORIZATION) {
        Some(member(&s, &headers).await?)
    } else {
        None
    };
    Ok(Json(s.accept_invitation(actor.as_ref(), body).await?))
}
async fn friends(
    State(s): State<Service>,
    headers: HeaderMap,
) -> Result<Json<Vec<Friend>>, ServiceError> {
    let actor = member(&s, &headers).await?;
    Ok(Json(s.friends(&actor).await?))
}
async fn request_friend(
    State(s): State<Service>,
    headers: HeaderMap,
    Json(body): Json<FriendTarget>,
) -> Result<Json<Vec<Friend>>, ServiceError> {
    let actor = member(&s, &headers).await?;
    Ok(Json(s.request_friend(&actor, body).await?))
}
async fn accept_friend(
    State(s): State<Service>,
    headers: HeaderMap,
    Json(body): Json<FriendTarget>,
) -> Result<Json<Vec<Friend>>, ServiceError> {
    let actor = member(&s, &headers).await?;
    Ok(Json(s.accept_friend(&actor, body).await?))
}
async fn add_friend(
    State(s): State<Service>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<AddFriend>,
) -> Result<Json<Receipt>, ServiceError> {
    let actor = member(&s, &headers).await?;
    Ok(Json(s.add_friend(&actor, &id, body).await?))
}
async fn backends(
    State(s): State<Service>,
    headers: HeaderMap,
) -> Result<Json<Vec<BackendInfo>>, ServiceError> {
    member(&s, &headers).await?;
    Ok(Json(s.backends().await))
}
async fn workspaces(
    State(s): State<Service>,
    headers: HeaderMap,
) -> Result<Json<Vec<WorkspaceInfo>>, ServiceError> {
    let actor = member(&s, &headers).await?;
    Ok(Json(s.workspaces(&actor).await?))
}
async fn create_workspace(
    State(s): State<Service>,
    headers: HeaderMap,
    Json(body): Json<CreateWorkspace>,
) -> Result<Json<WorkspaceInfo>, ServiceError> {
    let actor = member(&s, &headers).await?;
    Ok(Json(s.create_workspace(&actor, body.title).await?))
}
async fn snapshot(
    State(s): State<Service>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Snapshot>, ServiceError> {
    let actor = member(&s, &headers).await?;
    Ok(Json(s.snapshot(&actor, &id).await?))
}
async fn command(
    State(s): State<Service>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Command>,
) -> Result<Json<Receipt>, ServiceError> {
    let actor = member(&s, &headers).await?;
    Ok(Json(s.command(&actor, &id, body).await?))
}

#[derive(Deserialize)]
struct Cursor {
    #[serde(default)]
    after: u64,
}

async fn events(
    State(s): State<Service>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<Cursor>,
) -> Result<Response, ServiceError> {
    let actor = member(&s, &headers).await?;
    let (replay, mut receiver) = s.subscribe(&actor, &id, query.after).await?;
    let mut stopping = s.stopping();
    let stream = async_stream::stream! {
        let mut cursor=query.after;
        for event in replay {
            if s.check_access(&actor,&id).await.is_err(){break;}
            cursor=event.sequence;
            yield Ok::<_,Infallible>(SseEvent::default().id(cursor.to_string()).json_data(&event).unwrap());
        }
        loop {
            if *stopping.borrow() { break; }
            let received = tokio::select! {
                _ = stopping.changed() => break,
                event = receiver.recv() => event,
            };
            match received {
                Ok((workspace,event)) if workspace==id && event.sequence>cursor => {
                    if s.check_access(&actor,&id).await.is_err(){break;}
                    cursor=event.sequence;
                    yield Ok(SseEvent::default().id(cursor.to_string()).json_data(&event).unwrap());
                }
                Ok(_) => {},
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    match s.subscribe(&actor,&id,cursor).await {
                        Ok((missed,next)) => {
                            receiver=next;
                            for event in missed { if s.check_access(&actor,&id).await.is_err(){return;} cursor=event.sequence; yield Ok(SseEvent::default().id(cursor.to_string()).json_data(&event).unwrap()); }
                        }
                        Err(_) => break,
                    }
                }
                Err(_) => break,
            }
        }
    };
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", header::HeaderValue::from_static("no"));
    Ok(response)
}
