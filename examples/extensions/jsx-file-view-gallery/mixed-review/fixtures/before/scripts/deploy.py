from dataclasses import dataclass
from pathlib import Path
from subprocess import run
from typing import Iterable


@dataclass(frozen=True)
class Service:
    name: str
    manifest: Path
    environment: str


def discover_services(root: Path) -> list[Service]:
    services: list[Service] = []
    for manifest in sorted(root.glob("services/*/service.toml")):
        services.append(
            Service(
                name=manifest.parent.name,
                manifest=manifest,
                environment="production",
            )
        )
    return services


def validate_service(service: Service) -> None:
    if not service.manifest.exists():
        raise ValueError(f"missing manifest for {service.name}")
    if service.environment not in {"staging", "production"}:
        raise ValueError(f"unsupported environment: {service.environment}")


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
    ]
    if dry_run:
        command.append("--dry-run")
    return command


def deploy(service: Service, dry_run: bool = False) -> None:
    validate_service(service)
    completed = run(build_command(service, dry_run), check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"deployment failed for {service.name}")


def deploy_all(services: Iterable[Service], dry_run: bool = False) -> None:
    for service in services:
        print(f"deploying {service.name} to {service.environment}")
        deploy(service, dry_run=dry_run)


def main() -> None:
    root = Path.cwd()
    services = discover_services(root)
    if not services:
        raise SystemExit("no services discovered")
    deploy_all(services)


if __name__ == "__main__":
    main()
