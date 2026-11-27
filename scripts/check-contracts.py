# SPDX-FileCopyrightText: 2026 Junctura Contributors
# SPDX-License-Identifier: Apache-2.0
"""Validate OpenAPI and in-memory HTTP observations; never log payloads."""
import copy
import hashlib
import json
import re
import sys
import urllib.request
from urllib.parse import urlsplit
from datetime import datetime
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.exceptions import Unresolvable
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / 'docs/contracts/foundation-api.openapi.json'
CAPABILITY_CONTRACT = ROOT / 'docs/contracts/capability-api-v1.openapi.json'
URI = CONTRACT.as_uri()
META = 'https://spec.openapis.org/oas/3.1/schema/2022-10-07'
META_SHA = 'da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0'
METHODS = {'get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace'}
COMPOSITION_ROUTES = {
    '/v1/compositions': {'post': 'registerComposition'},
    '/v1/compositions/{compositionId}/versions': {'post': 'registerCompositionVersion'},
    '/v1/compositions/{compositionId}/versions/{version}': {'get': 'getCompositionVersion', 'put': 'replaceCompositionDraft'},
    **{f'/v1/compositions/{{compositionId}}/versions/{{version}}/{action}': {'post': f'{action}CompositionVersion'}
       for action in ('validate', 'publish', 'deprecate', 'revoke')},
}


def composition_inventory(spec, source=None):
    """Independent route inventory bound to the actual handler regex and source."""
    expected_source = 'src/modules/capability/composition/registry.mjs'
    source = source if source is not None else (ROOT / expected_source).read_text(encoding='utf-8')
    match = re.search(r'const PATH = /(.*)/;', source)
    require(match is not None, 'Composition handler route declaration missing')
    route = re.compile(match[1].replace(r'\/', '/'))
    require(route.fullmatch('/v1/compositions/11111111-1111-4111-8111-111111111111') is None,
            'Composition handler serves an undocumented alias')
    actual = {p: set(m) & METHODS for p, m in spec['paths'].items() if p.startswith('/v1/compositions')}
    require(actual == {p: set(m) for p, m in COMPOSITION_ROUTES.items()}, 'Composition route inventory differs')
    for path, methods in COMPOSITION_ROUTES.items():
        concrete = path.replace('{compositionId}', '11111111-1111-4111-8111-111111111111').replace('{version}', '1.0.0')
        require(route.fullmatch(concrete) is not None, 'Composition contract route missing in source')
        for method, oid in methods.items():
            op = spec['paths'][path][method]
            require(op['operationId'] == oid, 'Composition operation incorrectly mapped')
            require(op.get('x-junctura-source') == expected_source, 'Composition operation source incorrectly mapped')
            require(op.get('x-junctura-status') == 'implemented-c4b-opt-in', 'Composition status missing')
            require(op.get('x-junctura-test-suite') == 'compositions', 'Composition coverage missing')
            require(op.get('security') == [{'oidcBearer': []}], 'Composition OIDC missing')
            require(f'request.method === "{method.upper()}"' in source or f'request.method !== "{method.upper()}"' in source,
                    'Composition method missing in handler')
    for action in ('cancel', 'resume'):
        op = spec['paths'][f'/v1/capability-executions/{{executionId}}/{action}']['post']
        require(op.get('x-junctura-status') == 'design-only', 'Unsupported execution operation marked implemented')
    runtime_source = 'src/modules/capability/composition/runtime.mjs'
    runtime = (ROOT / runtime_source).read_text(encoding='utf-8')
    router = (ROOT / 'src/api.mjs').read_text(encoding='utf-8')
    for path, method, entry in (('/v1/capability-executions', 'post', 'submit'),
                                ('/v1/capability-executions/{executionId}', 'get', 'get'),
                                ('/v1/capability-authorizations/introspect', 'post', 'introspect')):
        op = spec['paths'][path][method]
        require(op.get('x-junctura-source') == runtime_source, 'Composition execution source incorrectly mapped')
        require(op.get('x-junctura-status') == 'implemented-c4a-c4b-opt-in', 'Composition execution status missing')
        require(f'async {entry}(' in runtime and f'config.compositionRuntime.{entry}(' in router,
                'Composition execution handler missing')
    return sum(len(m) for m in COMPOSITION_ROUTES.values()) + 3
# Independently reviewed handler inventory, not extracted from the specification.
# When handlers change, review this inventory and add an observed positive case.
EXPECTED = {
    '/health': {'get', 'head'}, '/ready': {'get'}, '/metrics': {'get'}, '/v1/identity': {'get'}, '/v1/events': {'get'}, '/v1/token-exchange': {'post'},
    '/v1/queues/{queue}': {'put', 'delete'}, '/v1/queues/{queue}/messages': {'post'}, '/v1/queues/{queue}/lease': {'post'},
    '/v1/queues/{queue}/messages/{messageId}/ack': {'post'}, '/v1/queues/{queue}/messages/{messageId}/nack': {'post'},
    '/v1/queues/{queue}/dead-letters': {'get'}, '/v1/queues/{queue}/dead-letters/{messageId}/replay': {'post'},
    '/v1/me/resource-consents': {'get', 'post'}, '/v1/me/resource-consents/{consentId}/revoke': {'post'},
    '/v1/resource-consent-requests': {'post'}, '/v1/resource-consent-requests/{requestId}': {'get'},
    '/v1/resource-consent-requests/{requestId}/cancel': {'post'},
    '/v1/me/resource-consent-requests': {'get'},
    '/v1/me/resource-consent-requests/{requestId}/accept': {'post'},
    '/v1/me/resource-consent-requests/{requestId}/decline': {'post'},
    '/v1/applications': {'get', 'post'}, '/v1/applications/stats': {'get'}, '/v1/applications/{appId}': {'get', 'patch'},
    '/v1/applications/{appId}/assignments': {'get', 'post'},
    '/v1/applications/{appId}/assignments/{assignmentId}': {'delete'},
    '/v1/applications/{appId}/oidc-keys': {'get', 'post'},
    '/v1/applications/{appId}/approve': {'post'}, '/v1/applications/{appId}/state': {'post'},
    '/v1/approvals': {'post'}, '/v1/approvals/{approvalId}': {'get'},
    '/v1/approvals/{approvalId}/revoke': {'post'},
    '/v2/data-schemas/{collection}': {'put'},
    '/v2/data-masking/{collection}': {'get', 'put'},
    '/v2/data/{collection}/{id}:archive': {'post'},
    '/v2/data/{collection}/{id}:lock': {'post', 'delete'},
    '/v2/data/{collection}/aggregate': {'get'},
    '/v2/data/{collection}/by-key/{key}': {'put'}, '/v2/data:batch': {'post'},
    '/v2/data/{collection}/aggregate': {'get'}, '/v2/data:export': {'get'}, '/v2/data:import': {'post'},
    '/v2/data:export': {'get'}, '/v2/data:import': {'post'},
    '/v2/resource-shares': {'post'}, '/v2/resource-shares/{shareId}': {'delete'},
    '/v1/workflows/definitions': {'get', 'post'}, '/v1/workflows/executions': {'post'},
    '/v1/workflows/executions/{executionId}': {'get', 'delete'},
    '/v1/workflows/executions/{executionId}/complete': {'post'},
    '/v1/workflows/executions/{executionId}/history': {'get'},
    '/v1/workflows/tasks': {'get'}, '/v1/workflows/tasks/{taskId}/claim': {'post'},
    '/v1/workflows/tasks/{taskId}/release': {'post'},
    '/v1/directory/unit-types': {'get'}, '/v1/directory/unit-types/{unitType}': {'put', 'delete'},
    '/v1/directory/units': {'get'}, '/v1/directory/units/{unit}': {'put', 'delete'},
    '/v1/directory/units/{unit}/groups': {'get'},
    '/v1/directory/units/{unit}/groups/{group}': {'put', 'delete'},
    '/v1/directory/units/{unit}/members': {'get'},
    '/v1/directory/units/{unit}/members/{subject}': {'put', 'delete'},
}
for version in ('v1', 'v2'):
    EXPECTED.update({f'/{version}/data/{{collection}}': {'get', 'post'},
                     f'/{version}/data/{{collection}}/{{id}}': {'get', 'patch', 'delete'},
                     f'/{version}/objects/{{id}}': {'get', 'put', 'delete'}})
EXPECTED['/v1/objects'] = {'post'}
EXPECTED['/v2/objects'] = {'get', 'post'}
EXPECTED['/v1/search'] = {'get'}
OIDC = '/identity/realms/junctura'
EXPECTED[OIDC + '/.well-known/openid-configuration'] = {'get'}
for suffix, methods in {'auth': {'get'}, 'token': {'post'}, 'certs': {'get'},
                        'userinfo': {'get', 'post'}, 'logout': {'get', 'post'}}.items():
    EXPECTED[OIDC + '/protocol/openid-connect/' + suffix] = methods


class ContractError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ContractError(message)


def resolve(spec, value):
    if isinstance(value, dict) and '$ref' in value:
        ref = value['$ref']
        require(ref.startswith('#/'), 'Foundation references must be local fragments')
        target = spec
        try:
            for part in ref[2:].split('/'):
                target = target[part.replace('~1', '/').replace('~0', '~')]
        except (KeyError, TypeError):
            raise ContractError('Unresolved local reference') from None
        return target
    return value


FORMATS = FormatChecker()


@FORMATS.checks('date-time', raises=(ValueError, TypeError))
def date_time(value):
    if not isinstance(value, str):
        return True
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})', value):
        return False
    return datetime.fromisoformat(value.replace('Z', '+00:00')).tzinfo is not None


@FORMATS.checks('uri', raises=(ValueError, TypeError))
def absolute_uri(value):
    if not isinstance(value, str):
        return True
    parsed = urlsplit(value)
    return bool(parsed.scheme) and not re.search(r'[\s\x00-\x1f]', value) and (bool(parsed.netloc) if parsed.scheme in ('http', 'https') else bool(parsed.path))


def check_value(spec, schema, value, label):
    # Bind local component refs to the whole contract, not the nested schema.
    document = {**spec, '$defs': {'Observed': schema}}
    registry = Registry().with_resource(URI, Resource.from_contents(document, default_specification=DRAFT202012))
    validator = Draft202012Validator({'$ref': URI + '#/$defs/Observed'}, registry=registry, format_checker=FORMATS)
    error = next(validator.iter_errors(value), None)
    # jsonschema's normal messages can contain tokens/payloads. Never emit them.
    # Diagnostics list only JSON paths and keyword names, never values.
    require(error is None, label + ': schema mismatch' + (f' ({error.validator}{describe_error(error)})' if error else ''))


def describe_error(error):
    def where(item):
        path = '/'.join(str(part) for part in item.absolute_path)
        return '/' + path if path else '/'
    def token(item):
        # Server-defined machine codes are safe to show; never show other values.
        value = item.instance
        if item.validator != 'enum':
            return ''
        if isinstance(value, str) and re.fullmatch(r'[a-z_]{1,64}', value):
            return f'={value}'
        if isinstance(value, str):
            classes = ''.join(sorted({'a' if c.islower() else 'A' if c.isupper() else '9' if c.isdigit() else '_' if c == '_' else ' ' if c.isspace() else '.' for c in value}))
            return f'=<str len {len(value)} chars [{classes}]>'
        return f'=<{type(value).__name__}>'
    branches = []
    for item in error.context or []:
        branches.append(f'branch {item.relative_schema_path[0]} {where(item)} {item.validator}{token(item)}')
    detail = ' at ' + where(error)
    return detail + ('; ' + '; '.join(branches[:8]) if branches else '')


def validate_official_structure(*specs):
    with urllib.request.urlopen(META, timeout=20) as response:
        raw = response.read()
    require(hashlib.sha256(raw).hexdigest() == META_SHA, 'Official metaschema digest changed; review before updating pin')
    validator = Draft202012Validator(json.loads(raw))
    for spec in specs:
        error = next(validator.iter_errors(spec), None)
        require(error is None, 'Official OpenAPI structural validation failed')


def is_planned(operation):
    return operation.get('x-junctura-status') == 'planned'


def validate_references_and_inline_schemas(spec, dereference):
    def walk(value):
        if isinstance(value, dict):
            if '$ref' in value:
                require(isinstance(value['$ref'], str), 'Reference must be a string')
                dereference(value)
            for key, child in value.items():
                if key == 'schema' and isinstance(child, (dict, bool)):
                    Draft202012Validator.check_schema(child)
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
    walk(spec)


def validate_paths(spec, dereference, *, foundation=False):
    ids = set()
    bearer = 'coreBearer' if foundation else 'oidcBearer'

    def validate_operation(path, method, operation):
        oid = operation['operationId']
        require(oid not in ids, 'Duplicate operationId')
        ids.add(oid)
        planned = is_planned(operation)
        if not planned and not foundation:
            return
        if not planned:
            require((ROOT / operation['x-junctura-source']).is_file(), oid + ': source missing')
            require(operation['x-junctura-test-suite'] in ('core', 'applications', 'records', 'record-queries', 'record-archives', 'field-masking', 'app-group-shares', 'directory', 'workflow-tasks', 'events', 'message-queue', 'object-metadata', 'search', 'subject-access', 'app-access', 'delegation', 'consent', 'consent-requests', 'metrics'), oid + ': coverage suite missing')
        parameters = [dereference(p) for p in operation.get('parameters', [])]
        require(len({(p['in'], p['name']) for p in parameters}) == len(parameters), oid + ': duplicate parameter')
        require({p['name'] for p in parameters if p['in'] == 'path'} == set(re.findall(r'{([^}]+)}', path)), oid + ': path parameters differ')
        require(all(p.get('required') for p in parameters if p['in'] == 'path'), oid + ': path parameter optional')
        if path.startswith(('/v1/', '/v2/')):
            require(operation.get('security') == [{bearer: []}], oid + ': bearer protection missing')
            reader_only_write = path == '/v1/token-exchange' or path.startswith(('/v1/applications', '/v1/approvals',
                '/v1/me/resource-consents', '/v1/resource-consent-requests', '/v1/me/resource-consent-requests')) or (
                planned and path.startswith(('/v1/me/', '/v1/directory/')))
            roles = ['core-reader'] + (['core-writer'] if method != 'get' and not reader_only_write else [])
            require(operation.get('x-junctura-core-roles') == roles, oid + ': role contract differs')
        if path.startswith(('/v1/data/', '/v1/objects')):
            require(operation.get('deprecated') is True and operation['x-junctura-authority'] == 'legacy-tenant', oid + ': legacy boundary missing')
        if path.startswith('/v2/'):
            require(operation['x-junctura-authority'] == 'app-resource', oid + ': app boundary missing')
        if operation.get('x-junctura-test-suite') == 'message-queue' and 'requestBody' in operation:
            media = operation['requestBody']['content']['application/json']
            require('example' in media, oid + ': request example missing')
            check_value(spec, media['schema'], media['example'], oid + ' request example')

    planned_paths = {}
    for path, methods in spec['paths'].items():
        planned_paths[path] = {}
        for method, operation in methods.items():
            future = operation.get('x-junctura-planned-operation')
            if 'x-junctura-planned-operation' in operation:
                status = operation.get('x-junctura-status', spec.get('x-junctura-status'))
                require(isinstance(future, dict) and is_planned(future) and
                        isinstance(status, str) and (status == 'implemented' or status.startswith('implemented-')),
                        'Future operation must be planned and attached to an implemented operation')
            planned_paths[path][method] = operation if future is None else future
            validate_operation(path, method, operation)
            if future is not None:
                validate_operation(path, method, future)
    return {**spec, 'paths': planned_paths}, len(ids)


def validate_document(spec, official=True):
    require(spec.get('openapi') == '3.1.1', 'Expected OpenAPI 3.1.1')
    require(spec.get('x-junctura-status') == 'implemented', 'Foundation must describe implemented routes')
    actual = {}
    for path, item in spec['paths'].items():
        methods = set(item) & METHODS
        implemented = {method for method in methods if not is_planned(item[method])}
        if implemented or not methods:
            actual[path] = implemented
    require(actual == EXPECTED, 'Route/method inventory differs from reviewed handlers')

    def dereference(value):
        return resolve(spec, value)

    validate_references_and_inline_schemas(spec, dereference)
    for schema in spec['components']['schemas'].values():
        Draft202012Validator.check_schema(schema)
    # App bootstrap is an OpenBao contract. Core rotation responses stay receipt-only.
    rotation = spec['paths']['/v1/applications/{appId}/oidc-keys']
    for method in ('get', 'post'):
        response = dereference(rotation[method]['responses']['200'])
        schema = dereference(response['content']['application/json']['schema'])
        require(schema.get('additionalProperties') is False and set(schema['properties']) == {'items'},
                'OIDC rotation response must contain only receipts')
        receipt = dereference(schema['properties']['items']['items'])
        require(receipt.get('additionalProperties') is False and
                set(receipt['properties']) == {'rotationId', 'createdAt', 'appliedAt'},
                'OIDC rotation receipts must exclude connection credentials')
    planned, count = validate_paths(spec, dereference, foundation=True)
    if official:
        validate_official_structure(spec, planned)
    return count


def validate_observations(spec, observations, suite=None):
    covered = set()
    for item in observations:
        path, method = item['path'], item['method'].lower()
        require(path in spec['paths'], 'Observed route missing from Foundation')
        operation = spec['paths'][path].get(method)
        if operation and is_planned(operation):
            operation = None
        code = str(item['status'])
        label = operation['operationId'] if operation else 'unsupported method'
        if operation:
            require(code in operation['responses'], label + ': undocumented status ' + code)
            response = resolve(spec, operation['responses'][code])
        else:
            require(item['status'] in (400, 401, 403, 404, 405, 413, 429, 502, 503, 504), 'Undocumented method succeeded')
            name = {400:'BadRequest',401:'Unauthorized',403:'Forbidden',404:'NotFound',405:'MethodNotAllowed',413:'TooLarge',429:'RateLimited',502:'BadGateway',503:'Unavailable',504:'GatewayTimeout'}[item['status']]
            response = spec['components']['responses'][name]
        headers = item['responseHeaders']
        for name, value in response.get('headers', {}).items():
            definition = resolve(spec, value)
            require(not definition.get('required') or name.lower() in headers, label + ': required response header missing')
            if name.lower() in headers:
                check_value(spec, definition['schema'], headers[name.lower()], label + ' response header')
        if method == 'head' or item['status'] == 204:
            require(item['responseBytes'] == 0, label + ': body forbidden')
        elif 'content' in response:
            media = headers.get('content-type', '').split(';')[0].strip()
            require(media in response['content'], label + ': undocumented response content type')
            if media == 'application/json':
                require(not item.get('responseInvalidJson'), label + ': invalid response JSON')
                check_value(spec, response['content'][media]['schema'], item.get('responseBody'), label + ' response ' + str(item['status']))
            elif media == 'application/octet-stream':
                require(item['responseBytes'] > 0, label + ': empty object download')
                require(int(headers['content-length']) == item['responseBytes'], label + ': binary length mismatch')
            elif media != 'application/x-ndjson':
                require(item['responseBytes'] > 0, label + ': empty text representation')
        if not operation or item['status'] >= 400:
            continue  # Malformed/unauthorized negative requests need not satisfy a success request schema.
        covered.add(operation['operationId'])
        security = operation.get('security', [])
        require(not security or {} in security or item['authorized'], label + ': protected request succeeded without credentials')
        parameters = [resolve(spec, p) for p in operation.get('parameters', [])]
        query = dict(item['query'])
        known_query = set()
        for param in parameters:
            if param['in'] != 'query':
                continue
            name = param['name']
            known_query.add(name)
            if param.get('style') == 'deepObject':
                prefix = name + '['
                fields = {key[len(prefix):-1]: query.pop(key) for key in list(query)
                          if key.startswith(prefix) and key.endswith(']')}
                if fields:
                    query[name] = fields
            elif name in query and resolve(spec, param['schema']).get('type') == 'array':
                query[name] = item.get('repeatedQuery', {}).get(name, [query[name]])
        if operation['x-junctura-query-policy'] == 'closed':
            require(set(query) <= known_query, label + ': unknown query succeeded')
        for param in parameters:
            where = {'path': item['pathParams'], 'query': query, 'header': item['requestHeaders']}[param['in']]
            key = param['name'].lower() if param['in'] == 'header' else param['name']
            require(not param.get('required') or key in where, label + ': required request parameter missing')
            if key in where:
                value = where[key]
                schema = resolve(spec, param['schema'])
                if schema.get('type') == 'integer':
                    try:
                        value = int(value)
                    except (ValueError, TypeError):
                        raise ContractError(label + ': noninteger query') from None
                if schema.get('type') == 'boolean' and value in ('true', 'false'):
                    value = value == 'true'
                check_value(spec, param['schema'], value, label + ' request parameter')
        if 'requestBody' in operation:
            if not item['requestBytes'] and not operation['requestBody'].get('required'):
                continue
            require(item['requestBytes'] > 0, label + ': missing request body')
            require(item['requestBytes'] <= operation.get('x-max-body-bytes', 10485760), label + ': accepted oversized body')
            require(item['requestBytes'] >= operation.get('x-min-body-bytes', 0), label + ': accepted undersized body')
            media = item['requestHeaders'].get('content-type', '').split(';')[0].strip()
            require(media in operation['requestBody']['content'], label + ': accepted undocumented request media type')
            if media not in ('application/octet-stream', 'application/x-ndjson'):
                require(not item.get('requestInvalidJson'), label + ': accepted invalid request JSON')
                check_value(spec, operation['requestBody']['content'][media]['schema'], item.get('requestBody'), label + ' request')
    if suite:
        required = {o['operationId'] for m in spec['paths'].values() for o in m.values()
                    if not is_planned(o) and o['x-junctura-test-suite'] == suite}
        require(required <= covered, 'Missing positive operation coverage: ' + ', '.join(sorted(required - covered)))
    return len(observations), len(covered)


def self_test(spec):
    good = {'path':'/health','method':'GET','status':200,'authorized':False,'query':{},'pathParams':{},'requestHeaders':{},'requestBytes':0,
            'responseHeaders':{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff, nosniff'},
            'responseBody':{'service':'junctura-core','status':'ok'},'responseBytes':44}
    validate_observations(spec, [good])
    validate_document(spec, official=False)
    sender = '/v1/resource-consent-requests'
    subject = '/v1/me/resource-consent-requests/{requestId}'
    conflicts = {
        sender: 'consent_request_already_pending',
        sender + '/{requestId}/cancel': 'consent_request_not_pending',
        subject + '/accept': 'consent_request_target_changed',
        subject + '/decline': 'consent_request_not_pending',
    }
    for path, code in conflicts.items():
        response_body = {'error': code, 'requestId': '11111111-1111-4111-8111-111111111111'}
        conflict = {**good, 'path': path, 'method': 'POST', 'status': 409, 'responseBody': response_body}
        validate_observations(spec, [conflict])
        for invalid in ({'error': code}, {**response_body, 'extra': True}):
            try:
                validate_observations(spec, [{**conflict, 'responseBody': invalid}])
            except ContractError:
                continue
            raise ContractError(path + ': accepted an invalid consent request conflict')
    batch = spec['paths']['/v2/data:batch']['post']['requestBody']['content']['application/json']
    increments = batch['examples']['decrementInventory']['value']
    check_value(spec, batch['schema'], increments, 'Atomic batch example')
    record = {key: increments['operations'][0][key] for key in ('collection', 'id')}
    for operation in ({**record, 'op': 'delete'}, {**record, 'op': 'replace', 'data': {}}):
        check_value(spec, batch['schema'], {'operations': [{**operation, 'ifMatch': '"record-' + 'a' * 64 + '-2"'}]},
                    'Conditional batch example')
        try:
            check_value(spec, batch['schema'], {'operations': [operation]}, 'Missing batch ifMatch')
        except ContractError:
            continue
        raise ContractError('Batch replacement or deletion did not require ifMatch')
    fixture = copy.deepcopy(spec)
    # A synthetic planned route: observations may only reject it, never succeed.
    fixture['paths']['/v2/objects']['get']['x-junctura-status'] = 'planned'
    missing = {**good, 'path':'/v2/objects', 'status':405, 'responseBody':{'error':'method_not_allowed'}}
    validate_observations(fixture, [missing])
    try:
        validate_observations(fixture, [{**missing, 'status':200}])
    except ContractError as error:
        require(str(error) == 'Undocumented method succeeded', 'Planned route was checked as live')
    else:
        raise ContractError('Planned route was accepted as live')
    mutations = [lambda d:d.update(status=201), lambda d:d['responseBody'].pop('status'),
                 lambda d:d['responseBody'].update(status=123), lambda d:d['responseBody'].update(extra=True),
                 lambda d:d['responseHeaders'].update({'content-type':'text/plain'}),
                 lambda d:d['responseHeaders'].pop('cache-control')]
    for mutate in mutations:
        bad = copy.deepcopy(good)
        mutate(bad)
        try:
            validate_observations(spec, [bad])
        except ContractError:
            continue
        raise ContractError('Conformance validator accepted a deliberate regression')
    for change in ('duplicate', 'reference', 'route', 'security', 'legacy', 'bearer'):
        bad = copy.deepcopy(spec)
        if change == 'duplicate':
            bad['paths']['/health']['get']['operationId'] = bad['paths']['/ready']['get']['operationId']
        elif change == 'reference':
            bad['components']['schemas']['Record']['properties']['data'] = {'$ref': '#/components/schemas/Absent'}
        elif change == 'route':
            del bad['paths']['/health']['head']
        elif change == 'security':
            bad['paths']['/v2/objects']['post']['security'] = []
        elif change == 'legacy':
            bad['paths']['/v1/objects']['post']['deprecated'] = False
        elif change == 'bearer':
            bad['paths']['/v2/objects']['get']['security'] = []
        try:
            validate_document(bad, official=False)
        except ContractError:
            continue
        raise ContractError('Static validator accepted a deliberate ' + change + ' regression')
    protected = copy.deepcopy(good)
    protected.update(path='/v1/identity',
                     responseBody={'subject':'fixture','tenantId':'tenant-a','roles':['core-reader'],'units':[],'unitPaths':[],'groups':[]})
    try:
        validate_observations(spec, [protected])
    except ContractError:
        pass
    else:
        raise ContractError('Unauthenticated success was accepted')
    protected['authorized'] = True
    validate_observations(spec, [protected])
    capability = json.loads(CAPABILITY_CONTRACT.read_text(encoding='utf-8'))
    registry = capability_registry()
    # The consent overlays are promoted; overlay regressions run on a synthetic
    # implemented operation with the same shape (path parameter and body).
    extension = 'x-junctura-planned-operation'
    path = '/v1/me/fixtures/{id}'
    parent = {
        'operationId': 'fixtureConsentParent', 'summary': 'Fixture', 'tags': ['tenant'],
        'x-junctura-status': 'implemented-verified-subject', 'x-junctura-query-policy': 'closed',
        'security': [{'oidcBearer': []}], 'x-junctura-core-roles': ['core-reader'],
        'x-junctura-authority': 'tenant', 'x-junctura-required-permissions': ['verified-subject'],
        'x-junctura-source': 'src/modules/consent/consent.mjs', 'x-junctura-test-suite': 'capabilities',
        'parameters': [{'name': 'id', 'in': 'path', 'required': True,
                        'schema': {'$ref': './foundation-api.openapi.json#/components/schemas/Uuid'}}],
        'requestBody': {'required': True, 'content': {'application/json': {
            'schema': {'$ref': './foundation-api.openapi.json#/components/schemas/EmptyObject'}}}},
        'responses': {'200': {'description': 'Fixture response'}},
        extension: {
            'operationId': 'fixtureConsentPlanned', 'summary': 'Fixture', 'tags': ['tenant'],
            'x-junctura-status': 'planned', 'x-junctura-query-policy': 'closed',
            'security': [{'oidcBearer': []}], 'x-junctura-core-roles': ['core-reader'],
            'x-junctura-authority': 'tenant',
            'parameters': [{'name': 'id', 'in': 'path', 'required': True,
                            'schema': {'$ref': './foundation-api.openapi.json#/components/schemas/Uuid'}}],
            'requestBody': {'required': True, 'content': {'application/json': {
                'schema': {'$ref': './foundation-api.openapi.json#/components/schemas/EmptyObject'}}}},
            'responses': {'200': {'description': 'Fixture response'}},
        },
    }
    fixture = copy.deepcopy(capability)
    fixture['paths'][path] = {'get': copy.deepcopy(parent)}
    projected = validate_capability_plans(fixture, registry)
    require(not is_planned(parent) and projected['paths'][path]['get'] == parent[extension],
            'Capability plan did not replace only the implemented operation in the planned view')
    for on_parent, key, value, expected in (
        (True, 'x-junctura-status', 'design-only', 'Future operation must be planned'),
        (False, 'x-junctura-status', 'implemented', 'Future operation must be planned'),
        (False, 'security', [], 'bearer protection missing'),
        (False, 'x-junctura-core-roles', [], 'role contract differs'),
        (False, 'parameters', [], 'path parameters differ'),
        (False, 'requestBody', {'$ref': './foundation-api.openapi.json#/components/schemas/Absent'},
         'Unresolved Capability reference'),
    ):
        bad = copy.deepcopy(fixture)
        operation = bad['paths'][path]['get']
        target = operation if on_parent else operation[extension]
        target[key] = value
        try:
            validate_capability_plans(bad, registry)
        except ContractError as error:
            require(expected in str(error), 'Capability overlay was rejected for the wrong reason')
            continue
        raise ContractError('Capability checker accepted deliberate overlay regression: ' + key)
    composition_inventory(capability)
    for change in ('missing-route', 'wrong-source', 'wrong-operation', 'missing-handler'):
        bad = copy.deepcopy(capability)
        source = None
        op = bad['paths']['/v1/compositions']['post']
        if change == 'missing-route':
            del bad['paths']['/v1/compositions']
        elif change == 'wrong-source':
            op['x-junctura-source'] = 'src/api.mjs'  # Exists, but is the wrong mapping.
        elif change == 'wrong-operation':
            op['operationId'] = 'getCompositionVersion'
        else:
            source = (ROOT / op['x-junctura-source']).read_text(encoding='utf-8').replace('compositions', 'absent')
        try:
            composition_inventory(bad, source)
        except ContractError:
            continue
        raise ContractError('Composition checker accepted deliberate ' + change)
    print('Validator controls passed: wire/schema errors, auth bypass, missing routes/refs, duplicate IDs, planned batch preconditions, Foundation and Capability plans, legacy and Composition route/source regressions checked')


def capability_registry():
    return Registry().with_resources(
        (p.as_uri(), Resource.from_contents(json.loads(p.read_text(encoding='utf-8')), default_specification=DRAFT202012))
        for p in CAPABILITY_CONTRACT.parent.glob('*.json'))


def validate_capability_plans(spec, registry):
    uri = CAPABILITY_CONTRACT.as_uri()
    resolver = registry.with_resource(uri, Resource.from_contents(spec, default_specification=DRAFT202012)).resolver(uri)

    def dereference(value):
        if isinstance(value, dict) and '$ref' in value:
            try:
                return resolver.lookup(value['$ref']).contents
            except Unresolvable:
                raise ContractError('Unresolved Capability reference') from None
        return value

    validate_references_and_inline_schemas(spec, dereference)
    planned, _ = validate_paths(spec, dereference)
    return planned


def capability_contract(cases=None):
    """Validate local extension schemas and observed bodies without logging them."""
    contract = CAPABILITY_CONTRACT
    spec = json.loads(contract.read_text(encoding='utf-8'))
    registry = capability_registry()
    if cases is None:
        validate_official_structure(spec, validate_capability_plans(spec, registry))
        composition_inventory(spec)
    for schema in spec['components']['schemas'].values():
        Draft202012Validator.check_schema(schema)
    supplied = cases if cases is not None else list(json.loads((contract.parent / 'examples/api-examples.json').read_text(encoding='utf-8')).values())
    if cases is None:
        for path in spec['paths'].values():
            for operation in (op for method, op in path.items() if method in METHODS):
                if operation.get('x-junctura-test-suite') == 'access-requests' and 'requestBody' in operation:
                    media = operation['requestBody']['content']['application/json']
                    require('example' in media, operation['operationId'] + ': request example missing')
                    supplied.append({'schema': media['schema']['$ref'].rsplit('/', 1)[-1], 'value': media['example']})
    require(bool(supplied), 'Capability contract observations are empty')
    for item in supplied:
        validator = Draft202012Validator({'$ref': contract.as_uri() + '#/components/schemas/' + item['schema']}, registry=registry, format_checker=FORMATS)
        error = next(validator.iter_errors(item['value']), None)
        require(error is None, 'Capability ' + item['schema'] + ': schema mismatch')
    return len(supplied)


def main():
    spec = json.loads(CONTRACT.read_text(encoding='utf-8'))
    if '--capability-runtime' in sys.argv:
        batch = json.load(sys.stdin)
        count = capability_contract(batch['observations'])
        print(f'Capability contract: {count} observed schema cases passed')
    elif '--runtime' in sys.argv:
        batch = json.load(sys.stdin)
        count, covered = validate_observations(spec, batch['observations'], batch['suite'])
        print(f'Foundation conformance: {count} responses, {covered} successful operations ({batch["suite"]})')
    elif '--self-test' in sys.argv:
        self_test(spec)
    else:
        count = validate_document(spec)
        capability_contract()
        print(f'Foundation {count} operations and Capability OpenAPI structure/schemas/examples passed; planned authorization/references and Composition 11-operation route/source/status inventory verified')


if __name__ == '__main__':
    try:
        main()
    except ContractError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
