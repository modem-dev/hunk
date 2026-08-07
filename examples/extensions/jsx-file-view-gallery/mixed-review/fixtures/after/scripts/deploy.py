from dataclasses import dataclass
from pathlib import Path
from subprocess import run
from time import sleep
from typing import Iterable


@dataclass(frozen=True)
class Service:
    name: str
    manifest: Path
    environment: str
    retries: int = 2


def discover_services(root: Path, environment: str) -> list[Service]:
    services: list[Service] = []
    for manifest in sorted(root.glob("services/*/service.toml")):
        services.append(
            Service(
                name=manifest.parent.name,
                manifest=manifest,
                environment=environment,
            )
        )
    return services


def validate_service(service: Service) -> None:
    if not service.manifest.is_file():
        raise ValueError(f"missing manifest for {service.name}: {service.manifest}")
    if service.environment not in {"development", "staging", "production"}:
        raise ValueError(f"unsupported environment: {service.environment}")
    if service.retries < 0:
        raise ValueError("retries cannot be negative")


def build_command(service: Service, dry_run: bool) -> list[str]:
    command = [
        "deployctl",
        "apply",
        "--service",
        service.name,
        "--environment",
        service.environment,
        "--manifest",
        str(service.manifest),
        "--output",
        "json",
    ]
    if dry_run:
        command.append("--dry-run")
    return command


def deploy(service: Service, dry_run: bool = False) -> None:
    validate_service(service)
    for attempt in range(service.retries + 1):
        completed = run(build_command(service, dry_run), check=False)
        if completed.returncode == 0:
            return
        if attempt < service.retries:
            sleep(2**attempt)
    raise RuntimeError(f"deployment failed for {service.name} after retries")


def deploy_all(services: Iterable[Service], dry_run: bool = False) -> None:
    failures: list[str] = []
    for service in services:
        print(f"deploying {service.name} to {service.environment}")
        try:
            deploy(service, dry_run=dry_run)
        except RuntimeError:
            failures.append(service.name)
    if failures:
        raise RuntimeError(f"failed services: {', '.join(failures)}")


def main() -> None:
    root = Path.cwd()
    services = discover_services(root, environment="staging")
    if not services:
        raise SystemExit("no services discovered")
    deploy_all(services, dry_run=False)


if __name__ == "__main__":
    main()
