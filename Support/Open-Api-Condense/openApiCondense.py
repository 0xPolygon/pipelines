""" Condense app for open api apps
"""
import json
import os
import ruamel.yaml
import shutil
import traceback
import yaml
from pathlib import Path


class ReadWorkflowData:
    """Read workflow data."""

    def __init__(self, workflow_dict, filepath):
        self.workflow_dict = workflow_dict
        self.filepath = filepath
        self._set_first_job()
        self._read_params()

    def _read_params(self):
        self.trigger_branch = self._get_branch_name()
        self.trigger_path = self._get_trigger_path()
        self.region = self._get_region()
        self.app_name = self._get_app_name()
        self.cluster_name = self._get_cluster_name()
        self.env_name = self._get_env_name()
        self.task_defintion_file = self._get_task_def_file_path()
        self.account_number = self._get_account_number()
        self.docker_file = self._get_docker_file()
        self.workflow_name = self._get_workflow_name()

    def _set_first_job(self):
        self.job = ""
        if self.workflow_dict.get("jobs", {}):
            self.job = list(self.workflow_dict["jobs"].keys())[0]

    def _get_branch_name(self):
        return self.workflow_dict.get(True, {}).get("push", {}).get("branches", [""])

    def _get_trigger_path(self):
        trigger_folder = self.workflow_dict.get(True, {}).get("push", {}).get("paths")
        if len(trigger_folder) == 1:
            folder_taskdef = trigger_folder[0].strip("/**")
            taskdef_folder = os.sep.join([folder_taskdef, "taskdef"])
            trigger_folder.append("!" + taskdef_folder + "/**")
            github_workflow_file = self.filepath.split(".github/workflows", 1)[1]
            trigger_folder.append(".github/workflows" + github_workflow_file)
        return trigger_folder

    def _get_region(self):
        return self.workflow_dict.get("env", {}).get("AWS_REGION")

    def _get_app_name(self):
        return self.workflow_dict.get("env", {}).get("CONTAINER_NAME")

    def _get_cluster_name(self):
        return self.workflow_dict.get("env", {}).get("ECS_CLUSTER")

    def _get_env_name(self):
        return (
            self.workflow_dict.get("jobs", {}).get(self.job, {}).get("environment", "")
        )

    def _get_task_def_file_path(self):
        ecs_task_definition = self.workflow_dict.get("env", {}).get(
            "ECS_TASK_DEFINITION"
        )
        self.trigger_path.append(
            ecs_task_definition.replace(".json", ".yaml")
        )  # Trigger on taskdef file changes
        return ecs_task_definition

    def _get_account_number(self):
        steps = self.workflow_dict.get("jobs", {}).get(self.job, {}).get("steps", [])
        account = ""
        for step in steps:
            if "configure-aws-credentials" in step.get("uses", ""):
                role_assumed = step.get("with", {}).get("role-to-assume")
                account = (
                    role_assumed.strip().split("arn:aws:iam::", 1)[1].split(":", 1)[0]
                )
                break
        return account

    def _get_docker_file(self):
        steps = self.workflow_dict.get("jobs", {}).get(self.job, {}).get("steps", [])
        dockerfile = ""
        for step in steps:
            if "docker build -t" in step.get("run", ""):
                commands = step.get("run").split("\n")
                dockerfile = (
                    commands[0].split(":$IMAGE_TAG -f ", 1)[1].rsplit(" .", 1)[0]
                )
                break
        return dockerfile

    def _get_workflow_name(self):
        return self.workflow_dict.get("name", "").strip()


class ReadTaskdefData:
    def __init__(self, workflow_read_obj):
        self.relative_taskdef_file = workflow_read_obj.task_defintion_file
        self.repo_path = Path(workflow_read_obj.filepath).parent.parent.parent
        self._read_taskdef_file()
        self._read_app_container_def(workflow_read_obj.app_name)
        self._read_params()

    def _read_taskdef_file(self):
        self.task_def_file = os.sep.join(
            [str(self.repo_path), self.relative_taskdef_file]
        )
        with open(self.task_def_file, "r", encoding="utf-8") as file_obj:
            self.taskdef_data = json.load(file_obj)

    def _read_params(self):
        self.host_port, self.container_port = self._read_host_port()
        self.role = self._read_role()
        self.iac = self._read_iac()
        self.team_name = self._read_team_name()
        self.environment = self._read_environment()
        self.memory = self._read_memory()
        self.cpu = self._read_cpu()
        self.env_vars = self._read_env_vars()
        self.secrets = self._read_secrets()

    def _read_app_container_def(self, appname):
        containerDefs = self.taskdef_data.get("containerDefinitions", {})
        for container_def in containerDefs:
            if container_def.get("name") == appname:
                self.app_container_def = container_def

    def _read_host_port(self):
        port_mappings = self.app_container_def.get("portMappings", [{}])[0]
        host_port = port_mappings.get("hostPort")
        container_port = port_mappings.get("containerPort")
        return host_port, container_port

    def _read_role(self):
        tags = self.taskdef_data.get("tags", [])
        role = ""
        for tag in tags:
            if tag["key"] == "Role":
                role = tag["value"]
                break
        return role

    def _read_team_name(self):
        tags = self.taskdef_data.get("tags", [])
        team_name = ""
        for tag in tags:
            if tag["key"] == "Team":
                team_name = tag["value"]
                break
        return team_name

    def _read_environment(self):
        tags = self.taskdef_data.get("tags", [])
        environment = ""
        for tag in tags:
            if tag["key"] == "Environment":
                environment = tag["value"]
                break
        return environment

    def _read_iac(self):
        tags = self.taskdef_data.get("tags", [])
        iac = ""
        for tag in tags:
            if tag["key"] == "IAC":
                iac = tag["value"]
                break
        return iac

    def _read_memory(self):
        return self.taskdef_data.get("memory")

    def _read_cpu(self):
        return self.taskdef_data.get("cpu")

    def _read_env_vars(self):
        return self.app_container_def.get("environment", [])

    def _read_secrets(self):
        secret_list = self.app_container_def.get("secrets", [])
        return [element.get("name") for element in secret_list]


class OpenApiCondense:
    """Condenses github workflow and related taskdef file"""

    def __init__(self):
        self._total_lines_saved = 0
        self.total_files = 0

    def _read_yaml_file_data(self, filepath):
        data_dict = {}
        with open(filepath, "r") as file_obj:
            data_dict = yaml.safe_load(file_obj)
        return data_dict

    def _count_lines(self, file_path):
        with open(file_path, "r", encoding="utf-8") as file:
            line_count = sum(1 for line in file)
        return line_count

    def _check_if_updated(self, workflow_dict: dict) -> bool:
        """Checks if the workflow is already condensed by checking presence of uses: 0xPolygon/pipelines

        Args:
            workflow_dict (dict): Data read from yaml file in dict format

        Returns:
            bool: True if the file is already condensed
        """
        updated = False
        if workflow_dict.get("jobs", {}) and len(workflow_dict["jobs"].keys()) == 1:
            job = list(workflow_dict["jobs"].keys())[0]
            if (
                workflow_dict["jobs"][job]
                .get("uses", "")
                .startswith("0xPolygon/pipelines")
            ):
                updated = True
        return updated

    def _create_github_workflow_file(self, workflow_read_obj):
        workflow_dict = {}
        workflow_dict["name"] = workflow_read_obj.workflow_name
        workflow_dict["on"] = {
            "push": {
                "branches": workflow_read_obj.trigger_branch,
                "paths": workflow_read_obj.trigger_path,
            },
            "workflow_dispatch": "",
        }
        taskdef_file_vars = workflow_read_obj.task_defintion_file.replace(
            ".json", ".yaml"
        )
        workflow_dict["jobs"] = {
            "deploy": {
                "uses": "0xPolygon/pipelines/.github/workflows/ecs_deploy_docker_taskdef.yaml@main"
            },
            "with": {
                "app_name": workflow_read_obj.app_name,
                "taskdef_file_vars": taskdef_file_vars,
                "account_number": workflow_read_obj.account_number,
                "aws_region": workflow_read_obj.region,
                "environment": workflow_read_obj.env_name,
                "docker_file": workflow_read_obj.docker_file,
                "cluster_name": workflow_read_obj.cluster_name,
            },
            "secrets": "inherit",
        }
        desired_key_order = ["name", "on", "jobs"]
        with open(workflow_read_obj.filepath, "w", encoding="utf-8") as file_obj:
            yaml_rumael = ruamel.yaml.YAML()
            yaml_rumael.dump(
                {key: workflow_dict[key] for key in desired_key_order}, file_obj
            )
        return workflow_read_obj.filepath

    def _create_taskdef_file(self, workflow_read_obj, taskdef_read_obj):
        taskdef_dict = {
            "region": workflow_read_obj.region,
            "account_number": workflow_read_obj.account_number,
            "hostport": taskdef_read_obj.host_port,
            "containerport": taskdef_read_obj.container_port,
            "app_name": workflow_read_obj.app_name,
            "role": taskdef_read_obj.role,
            "environment": taskdef_read_obj.environment,
            "iac": taskdef_read_obj.iac,
            "team_name": taskdef_read_obj.team_name,
            "memory": int(taskdef_read_obj.memory),
            "cpu": int(taskdef_read_obj.cpu),
            "secret_vars": taskdef_read_obj.secrets,
        }
        if taskdef_read_obj.env_vars:
            taskdef_dict["env_vars"] = []
        for env in taskdef_read_obj.env_vars:
            taskdef_dict["env_vars"].append(
                {"name": env.get("name"), "value": env.get("value")}
            )
        new_file_path = (
            taskdef_read_obj.task_def_file[
                : -(len(os.path.splitext(taskdef_read_obj.task_def_file)[1]))
            ]
            + ".yaml"
        )

        desired_key_order = [
            "region",
            "account_number",
            "hostport",
            "containerport",
            "app_name",
            "role",
            "environment",
            "iac",
            "team_name",
            "memory",
            "cpu",
            "env_vars",
            "secret_vars",
        ]
        with open(taskdef_read_obj.task_def_file, "w", encoding="utf-8") as file_obj:
            yaml_rumael = ruamel.yaml.YAML()
            yaml_rumael.dump(
                {key: taskdef_dict[key] for key in desired_key_order}, file_obj
            )
        shutil.move(taskdef_read_obj.task_def_file, new_file_path)
        return taskdef_read_obj.task_def_file

    def _compare_file_lines(
        self, old_workflow_lines, old_taskdef_lines, new_workflow, new_taskdef
    ):
        new_workflow_lines = self._count_lines(new_workflow)
        new_taskdef_lines = self._count_lines(new_taskdef)
        app_lines_saved = (
            old_workflow_lines
            + old_taskdef_lines
            - new_workflow_lines
            - new_taskdef_lines
        )
        app_name = os.path.basename(new_workflow)
        print(f"{app_name} lines saved: {app_lines_saved}")
        self._total_lines_saved += app_lines_saved

    def process_github_workflow(self, filepath: str):
        """Reads github workflow and converts it into condensed format

        Args:
            filepath (str): Github workflow file path
        """
        workflow_dict = self._read_yaml_file_data(filepath)
        if self._check_if_updated(workflow_dict):
            return
        try:
            workflow_read_obj = ReadWorkflowData(workflow_dict, filepath)
            if not workflow_read_obj.account_number:
                print(f"Issue with current github workflow {filepath}")
                return
        except TypeError:
            print(f"Issue with current github workflow {filepath}")
            return
        taskdef_read_obj = ReadTaskdefData(workflow_read_obj)
        old_workflow_lines = self._count_lines(filepath)
        old_taskdef_lines = self._count_lines(taskdef_read_obj.task_def_file)

        new_workflow_file = self._create_github_workflow_file(workflow_read_obj)
        new_taskdef_file = self._create_taskdef_file(
            workflow_read_obj, taskdef_read_obj
        )
        self._compare_file_lines(
            old_workflow_lines,
            old_taskdef_lines,
            new_workflow_file,
            new_taskdef_file.replace(".json", ".yaml"),
        )
        self.total_files += 1

    def process_all_files(self, directory):
        all_files = [
            os.sep.join([directory, filepath])
            for filepath in os.listdir(directory)
            if filepath.endswith(".yaml") or filepath.endswith(".yml")
        ]
        for filepath in all_files:
            try:
                self.process_github_workflow(filepath)
            except Exception:
                print(f"Error {traceback.format_exc()}")
                break
        print(f"Total lines saved {self._total_lines_saved}")
        print(f"Total files processed {self.total_files}")


if __name__ == "__main__":
    CONDENSER = OpenApiCondense()
    CONDENSER.process_all_files("/open-api/.github/workflows")
