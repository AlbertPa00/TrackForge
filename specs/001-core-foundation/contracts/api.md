# API Contracts: Core Foundation

## Base URL

`http://localhost:3000/rest/api/2`

## Endpoints

### `POST /project`

Create a project.

### `GET /project`

List all projects.

### `GET /project/{key}`

Get a project by key.

### `POST /issue`

Create an issue.

### `GET /issue/{issueKey}`

Get an issue by key.

### `PUT /issue/{issueKey}`

Update an issue's fields, including status transitions.

### `GET /search?jql=project={key}`

List issues for a project using a simplified JQL parser.

## Common Response Shapes

See [data-model.md](../data-model.md) for full request/response examples.

## Error Format

```json
{
  "errorMessages": ["Issue does not exist or you do not have permission to see it."],
  "errors": {}
}
```
