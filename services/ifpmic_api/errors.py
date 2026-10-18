"""Fixed public errors. Private exception text is never a response field."""


class ApiError(Exception):
    STATUS = {'AUTH_REQUIRED': 401, 'FORBIDDEN': 403, 'CSRF_INVALID': 403, 'ORIGIN_FORBIDDEN': 403,
              'INVALID_REQUEST': 422, 'REQUEST_TOO_LARGE': 422,
              'DEPENDENCY_UNAVAILABLE': 503, 'COMMIT_UNCERTAIN': 503}

    def __init__(self, code):
        self.code = code
        self.status = self.STATUS[code]
        super().__init__(code)
