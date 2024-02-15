"""Executes terraform plan on folders where github changes are detected under a subfolder
"""

import argparse
import os
import subprocess


def get_directories_changed(parent_directory: str):
    """Builds a list of directories under a sub folder in a repository
       where a change is detected through git diff

    Args:
        parent_directory (str): Parent directory to search for changes

    Returns:
        list: Directories updated through latest changes.
    """
    os.chdir(parent_directory)
    result = subprocess.run(
        ["git", "diff", "--name-only", "--exit-code"],
        stdout=subprocess.PIPE,
        check=False,
    )
    directories_changed = []
    for filepath in result.stdout.decode().splitlines():
        filepath = parent_directory + os.sep + str(filepath)
        dir_path = filepath.rsplit(os.sep, 1)[0]
        directories_changed.append(dir_path)
    return directories_changed


def find_tf_directories(path: str):
    """Function to find .tf file folders in subfolders

    Args:
        path (str): Path under git repo location where to search for terraform file
           containing folders

    Returns:
        list: Folder path where the terrform files exist under the search path
    """
    tf_folders = []
    for root, _, files in os.walk(path):
        for file in files:
            if file.endswith(".tf"):
                tf_folders.append(root)
                break
    return tf_folders


# Function to run terraform init and plan in a directory
def run_terraform(path, issues_with_folders):
    """Executes terraform init and terraform plan in the identified folders.
       Builds a list of folders where issues are found during cmd execution.

    Args:
        path (str): Path under which to execute terraform init and plan
        issues_with_folders (list): List of folder with issues built for review
    """
    try:
        os.chdir(path)
        subprocess.run(["terraform", "init"], check=True)
        result = subprocess.run(["terraform", "plan"], capture_output=True, check=False)
        if result.returncode != 0:
            output = result.stdout.decode("utf-8")
            issues_with_folders.append({path: str(output)})
        else:
            print(f"Terraform commands executed successfully in {path}")
    except subprocess.CalledProcessError as e:
        print(f"Error executing Terraform commands in {path}: {e}")
        issues_with_folders.append({path: str(e)})


def parse_arguments():
    """Parses command line arguments to identify which repository to process

    Returns:
        dict: arguments received from command line
    """
    parser = argparse.ArgumentParser(
        description="Run Terraform commands in directories with changes in .tf files."
    )
    parser.add_argument(
        "-root",
        "--root_dir",
        type=str,
        help="Root directory of the Terraform project",
    )
    parser.add_argument(
        "-sub",
        "--sub_dir",
        type=str,
        help="Root directory of the Terraform project",
    )
    return parser.parse_args()


def _review_folders_with_issues(issues_with_folders: list):
    """Prints issue with folders found during terraform commands execution.

    Args:
        issues_with_folders (list): [{folder: error}, ...] format
    """
    folders_with_issue = len(issues_with_folders)
    for i, issue in enumerate(issues_with_folders):
        print(f"Issues with terraform plan on folder {i+1}/{folders_with_issue}:")
        for key in issue:
            print(key, issue[key])


def main():
    """Processes the terraform init and plan process for target repository"""
    args = parse_arguments()
    directories_changed = get_directories_changed(args.root_dir)
    tf_dirs = find_tf_directories(args.root_dir + os.sep + args.sub_dir)
    issues_with_folders = []
    for check_path in tf_dirs:
        if check_path in directories_changed:
            run_terraform(check_path, issues_with_folders)
    _review_folders_with_issues(issues_with_folders)


if __name__ == "__main__":
    main()
