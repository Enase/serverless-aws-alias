'use strict';
/**
 * Rebuild the stack structure.
 * ===========================
 * This enables us to deploy different function/resource sets per alias, e.g.
 * if a developer wants to deploy his very own branch as an alias.
 * We also have to retrieve the currently deployed stack template to
 * check for functions that might have been deleted in all other alias
 * stacks, or ones that have been added in the current alias stack.
 */

const BbPromise = require('bluebird');
const _ = require('lodash');

/**
 * Merge template definitions that are still in use into the new template
 * @param stackName {String} Main stack name
 * @param newTemplate {Object} New main stack template
 * @param currentTemplate {Object} Currently deployed main stack template
 * @param aliasStackTemplates {Array<Object>} Currently deployed and references aliases
 */
function mergeAliases(stackName, newTemplate, currentTemplate, aliasStackTemplates) {

	// Get all referenced function logical resource ids
	const aliasedFunctions =
		_.flatMap(
			aliasStackTemplates,
			template => _.compact(_.map(
				template.Resources,
				(resource, name) => {
					if (resource.Type === 'AWS::Lambda::Alias') {
						return {
							name: _.replace(name, /Alias$/, 'LambdaFunction'),
							version: _.replace(_.get(resource, 'Properties.FunctionVersion.Fn::ImportValue'), `${stackName}-`, '')
						};
					}
					return null;
				}
			))
		);

	// Get currently deployed function definitions and versions and retain them in the stack update
	const usedFunctionElements = {
		Resources: _.map(aliasedFunctions, aliasedFunction => _.assign(
				{},
				_.pick(currentTemplate.Resources, [ aliasedFunction.name, aliasedFunction.version ])
			)),
		Outputs: _.map(aliasedFunctions, aliasedFunction => _.assign(
				{},
				_.pick(currentTemplate.Outputs, [ `${aliasedFunction.name}Arn`, aliasedFunction.version ])
			))
	};

	_.forEach(usedFunctionElements.Resources, resources => _.defaults(newTemplate.Resources, resources));
	_.forEach(usedFunctionElements.Outputs, outputs => _.defaults(newTemplate.Outputs, outputs));

}

module.exports = {

	aliasLoadCurrentCFStackAndDependencies() {

		return BbPromise.join(
			BbPromise.bind(this).then(this.aliasStackLoadCurrentTemplate),
			BbPromise.bind(this).then(this.aliasStackLoadAliasTemplates)
		)
		.spread((currentTemplate, aliasStackTemplates) => {
			this._serverless.service.provider.deployedCloudFormationTemplate = currentTemplate;
			this._serverless.service.provider.deployedAliasTemplates = aliasStackTemplates;
			return BbPromise.resolve([ currentTemplate, aliasStackTemplates ]);
		});

	},

	aliasHandleFunctions(currentTemplate, aliasStackTemplates) {

		this._serverless.cli.log('Resolving function versions ...');

		const stackName = this._provider.naming.getStackName();
		const stageStack = this._serverless.service.provider.compiledCloudFormationTemplate;
		const aliasStack = this._serverless.service.provider.compiledCloudFormationAliasTemplate;

		/**
		 * Add the stage stack reference to the alias stack.
		 * This makes sure that the stacks are linked together.
		 */
		aliasStack.Outputs.ServerlessAliasReference = {
			Description: 'Alias stack reference.',
			Value: {
				'Fn::ImportValue': `${this._provider.naming.getStackName()}-ServerlessAliasReference`
			}
		};


		const versions = _.pickBy(stageStack.Resources, [ 'Type', 'AWS::Lambda::Version' ]);
		if (!_.isEmpty(versions)) {

			// The alias stack will be the owner of the versioned functions
			_.forEach(_.keys(versions), key => {
				delete stageStack.Resources[key];
			});

			_.forEach(versions, (version, versionName) => {
				const name = _.replace(_.get(version, 'Properties.FunctionName.Ref'), /LambdaFunction$/, '');

				delete stageStack.Outputs[`${name}LambdaFunctionQualifiedArn`];

				// Add function Arn export to stage stack
				stageStack.Outputs[`${name}LambdaFunctionArn`] = {
					Description: 'Function Arn',
					Value: { 'Fn::GetAtt': [ `${name}LambdaFunction`, 'Arn' ] },  // Ref: `${name}LambdaFunction` }
					Export: {
						Name: `${stackName}-${name}-LambdaFunctionArn`
					}
				};

				// Set correct function name in version
				version.Properties.FunctionName = { 'Fn::ImportValue': `${stackName}-${name}-LambdaFunctionArn` };

				// Add alias to alias stack. Reference the version export in the stage stack
				// to prevent version deletion.
				const alias = {
					Type: 'AWS::Lambda::Alias',
					Properties: {
						Description: _.get(stageStack.Resources, `${name}LambdaFunction.Properties.Description`),
						FunctionName: {
							'Fn::ImportValue': `${stackName}-${name}-LambdaFunctionArn`
						},
						FunctionVersion: { 'Fn::GetAtt': [ versionName, 'Version' ] },
						Name: this._alias
					},
					DependsOn: [
						versionName
					]
				};

				aliasStack.Resources[`${name}Alias`] = alias;
			});

			_.assign(aliasStack.Resources, versions);
		}

		// Merge function aliases and versions
		mergeAliases(stackName, stageStack, currentTemplate, aliasStackTemplates);

		// FIXME: Resource handling
		// mergeResources()

		// Promote the parsed templates to the promise chain.
		return BbPromise.resolve([ currentTemplate, aliasStackTemplates ]);
	},

	aliasHandleApiGateway(currentTemplate, aliasStackTemplates) {

		const stackName = this._provider.naming.getStackName();
		const stageStack = this._serverless.service.provider.compiledCloudFormationTemplate;
		const aliasStack = this._serverless.service.provider.compiledCloudFormationAliasTemplate;

		// Check if our current deployment includes an API deployment
		let exposeApi = _.includes(_.keys(stageStack.Resources), 'ApiGatewayRestApi');
		const aliasResources = [];

		if (!exposeApi) {
			// Check if we have any aliases deployed that reference the API.
			if (_.some(aliasStackTemplates, template => _.find(template.Resources, [ 'Type', 'AWS::ApiGateway::Deployment' ]))) {
				// Fetch the Api resource from the current stack
				stageStack.Resources.ApiGatewayRestApi = currentTemplate.Resources.ApiGatewayRestApi;
				exposeApi = true;
			}
		}

		if (exposeApi) {

			// Export the API for the alias stacks
			stageStack.Outputs.ApiGatewayRestApi = {
				Description: 'API Gateway API',
				Value: { Ref: 'ApiGatewayRestApi' },
				Export: {
					Name: `${stackName}-ApiGatewayRestApi`
				}
			};

			// Move the API deployment into the alias stack. The alias is the owner of the APIG stage.
			const deployment = _.pickBy(stageStack.Resources, [ 'Type', 'AWS::ApiGateway::Deployment' ]);
			if (!_.isEmpty(deployment)) {
				const deploymentName = _.keys(deployment)[0];
				const obj = deployment[deploymentName];
				obj.Properties.StageName = this._alias;
				obj.Properties.RestApiId = { 'Fn::ImportValue': `${stackName}-ApiGatewayRestApi` };
				delete obj.DependsOn;
				aliasResources.push(deployment);
				delete stageStack.Resources[deploymentName];
			}

			// Fetch lambda permissions. These have to be updated later to allow the aliased functions.

			// Fetch APIG methods and change them to point to the aliases


		}

		_.forEach(aliasResources, resource => _.assign(aliasStack.Resources, resource));

		return BbPromise.resolve([ currentTemplate, aliasStackTemplates ]);
	},

	aliasRestructureStack() {

		this._serverless.cli.log('Preparing aliases ...');

		return BbPromise.bind(this)
		.then(this.aliasLoadCurrentCFStackAndDependencies)
		.spread(this.aliasHandleFunctions)
		.spread(this.aliasHandleApiGateway)
		.then(() => BbPromise.resolve());
	}

};