import hmac
from dataclasses import dataclass

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request

from .config import Config
from .deadlines import DeadlineStore, ExtendError
from .destroy_flow import DestroyFlow
from .models import DestroyRequest, ExtendRequest, ExtendResponse, Status
from .state import InvalidTransition, State, StateStore
from .status import StatusBuilder
from .workflows import WorkflowError, WorkflowStore


@dataclass
class Deps:
    cfg: Config
    states: StateStore
    deadlines: DeadlineStore
    status: StatusBuilder
    flow: DestroyFlow
    workflows: WorkflowStore


def create_app(deps: Deps) -> FastAPI:
    app = FastAPI(title="vastcomfy-agent", version="1")

    def require_token(authorization: str | None = Header(default=None)) -> None:
        supplied = authorization[len("Bearer "):] if authorization and authorization.startswith("Bearer ") else ""
        if not hmac.compare_digest(supplied.encode(), deps.cfg.agent_token.encode()):
            raise HTTPException(status_code=401, detail="invalid token", headers={"WWW-Authenticate": "Bearer"})

    guarded = [Depends(require_token)]

    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    @app.get("/status", response_model=Status, dependencies=guarded)
    def get_status() -> Status:
        return deps.status.build()

    @app.post("/extend", response_model=ExtendResponse, dependencies=guarded)
    def extend(body: ExtendRequest) -> ExtendResponse:
        try:
            if body.kind == "failsafe":
                new = deps.deadlines.extend_failsafe(body.minutes, deps.cfg.extend_max_failsafe_min)
            else:
                new = deps.deadlines.extend_idle(body.minutes, deps.cfg.extend_max_idle_min)
        except ExtendError as err:
            raise HTTPException(status_code=400, detail={"code": err.code, "message": err.message}) from None
        return ExtendResponse(kind=body.kind, deadline=new)

    @app.post("/destroy", status_code=202, dependencies=guarded)
    def destroy(body: DestroyRequest, tasks: BackgroundTasks) -> dict:
        try:
            deps.states.set(State.STOPPING, body.reason)
        except InvalidTransition:
            pass
        tasks.add_task(deps.flow.run, body.reason)
        return {"accepted": True}

    @app.get("/workflows", dependencies=guarded)
    def list_workflows() -> list[dict]:
        return deps.workflows.list()

    @app.get("/workflows/{name}", dependencies=guarded)
    def get_workflow(name: str):
        try:
            return deps.workflows.read(name)
        except WorkflowError as err:
            raise HTTPException(status_code=err.status, detail=err.message) from None

    @app.put("/workflows/{name}", dependencies=guarded)
    async def put_workflow(name: str, request: Request) -> dict:
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > deps.cfg.workflow_max_bytes:
            raise HTTPException(status_code=413, detail=f"workflow larger than {deps.cfg.workflow_max_bytes} bytes")
        body = await request.body()
        try:
            size = deps.workflows.write(name, body)
        except WorkflowError as err:
            raise HTTPException(status_code=err.status, detail=err.message) from None
        return {"name": name, "bytes": size}

    return app
