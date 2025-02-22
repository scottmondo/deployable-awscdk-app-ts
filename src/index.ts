import {awscdk, TextFile} from 'projen'
import {Job, JobPermission} from 'projen/lib/github/workflows-model'
import * as steps from './steps'
import {DeployableAwsCdkTypeScriptAppOptions, DeployOptions, EnvironmentOptions} from './types'

export * from './types'

export class DeployableAwsCdkTypeScriptApp extends awscdk.AwsCdkTypeScriptApp {

  private readonly deployable: boolean
  private readonly generateNvmrc: boolean
  private readonly checkActiveDeployment: boolean
  private readonly workflowNodeVersion?: string
  private readonly deployOptions: DeployOptions

  constructor(options: DeployableAwsCdkTypeScriptAppOptions) {
    const deployable = options.release ?? true
    super({
      ...options,
      release: deployable,
    })
    this.deployable = deployable
    this.generateNvmrc = options.generateNvmrc ?? true
    this.checkActiveDeployment = options.checkActiveDeployment ?? false
    this.workflowNodeVersion = options.workflowNodeVersion
    this.deployOptions = options.deployOptions ?? {environments: []}
    this.addDevDeps('deployable-awscdk-app-ts')

    if (!deployable)
      this.logger.warn('The project is explicitly set to not release, make sure this is desired setting')

    if (this.generateNvmrc && !this.workflowNodeVersion)
      this.workflowNodeVersion = '14.18.1'
  }

  synth() {
    if (this.deployable)
      this.addDeployJobs()

    if (this.generateNvmrc)
      new TextFile(this, '.nvmrc', {
        lines: [this.workflowNodeVersion ?? ''],
      })

    const deployArgument = this.deployOptions.stackPattern ? ` ${this.deployOptions.stackPattern}`: ''
    this.addTask('deploy:workflow', {
      exec: `cdk deploy${deployArgument} --require-approval never`,
    })

    super.synth()
  }

  addEnvironments(...items: EnvironmentOptions[]) {
    this.deployOptions.environments.push(...items)
  }

  private addDeployJobs() {

    if (this.deployOptions.environments.length === 0)
      this.logger.warn('The project does not have any environment set, make sure this is desired setting')

    const include = this.deployOptions.environments.map(environmentOptions => {
      const {awsCredentials} = environmentOptions

      const assumeRole = awsCredentials.roleToAssume ? 'true' : 'false'

      const assumeRoleSettings = awsCredentials.roleToAssume ? {
        roleToAssume: awsCredentials.roleToAssume,
        assumeRoleDurationSeconds: awsCredentials.assumeRoleDurationSeconds || 900,
      }: undefined

      const accessKeyIdSecretName = awsCredentials.accessKeyIdSecretName ?? 'AWS_ACCESS_KEY_ID'
      const secretAccessKeySecretName = awsCredentials.secretAccessKeySecretName ?? 'AWS_SECRET_ACCESS_KEY'

      const hasPostDeployTask = environmentOptions.postDeployWorkflowScript ? 'true' : 'false'

      return {
        environment: environmentOptions.name,
        accessKeyIdSecretName,
        secretAccessKeySecretName,
        region: awsCredentials.region,
        assumeRole,
        hasPostDeployTask,
        postDeploymentScript: environmentOptions.postDeployWorkflowScript || '',
        ...assumeRoleSettings,
      }
    })

    const jobDefinition: Job = {
      runsOn: ['ubuntu-latest'],
      concurrency: 'deploy',
      needs: [
        'release_github',
      ],
      permissions: {
        contents: JobPermission.READ,
        deployments: JobPermission.READ,
      },
      strategy: {
        maxParallel: 1,
        matrix: {
          domain: {
            environment: include.map(e => e.environment),
          },
          include,
        },
      },
      environment: {
        name: '${{ matrix.environment }}',
      },
      steps: [],
    }

    jobDefinition.steps.push(steps.checkoutStep())

    if (this.checkActiveDeployment)
      jobDefinition.steps.push(steps.checkActiveDeploymentStep())

    if (this.workflowNodeVersion)
      jobDefinition.steps.push(steps.setNodeVersionStep(this.workflowNodeVersion, this.checkActiveDeployment))

    jobDefinition.steps.push(steps.installDependenciesStep(this.package.installCommand, this.checkActiveDeployment))
    jobDefinition.steps.push(...steps.setAwsCredentialsSteps(this.checkActiveDeployment))

    if (this.deployOptions.npmConfigEnvironment)
      jobDefinition.steps.push(steps.setNpmConfig(this.deployOptions.npmConfigEnvironment, '${{ matrix.environment }}', this.checkActiveDeployment))

    jobDefinition.steps.push(steps.deploymentStep(this.checkActiveDeployment, this.packageManager))
    jobDefinition.steps.push(steps.postDeploymentStep(this.checkActiveDeployment, this.packageManager))

    this.release?.addJobs({deploy: jobDefinition})

  }
}