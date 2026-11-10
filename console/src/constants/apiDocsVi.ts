// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

export type ApiDocsGroupId =
  | "identity"
  | "applications"
  | "data"
  | "files"
  | "workflows"
  | "capabilities"
  | "execution"
  | "audit"
  | "operations";

export const API_DOCS_GROUP_ORDER: ApiDocsGroupId[] = [
  "identity",
  "applications",
  "data",
  "files",
  "workflows",
  "capabilities",
  "execution",
  "audit",
  "operations",
];

export interface ApiDocsCopy {
  summary: string;
  when: string;
}

export const API_DOCS_COPY_VI: Record<string, ApiDocsCopy> = {
  getHealth: { summary: "Kiểm tra tiến trình Core còn sống.", when: "Dùng trong giám sát để phát hiện dịch vụ đã dừng." },
  headHealth: { summary: "Kiểm tra nhanh tiến trình Core mà không tải nội dung.", when: "Dùng cho health check tần suất cao, chỉ cần mã trạng thái." },
  getReadiness: { summary: "Kiểm tra các dịch vụ phụ thuộc đã sẵn sàng nhận việc.", when: "Dùng trước khi gửi lưu lượng thật hoặc lúc khởi động hệ thống." },
  getIdentity: { summary: "Trả về danh tính đã xác minh: chủ thể, tổ chức và vai trò.", when: "Dùng sau khi có token để biết ứng dụng đang gọi với danh tính nào." },
  getOidcDiscovery: { summary: "Công bố cấu hình OIDC: địa chỉ token, khóa ký và các luồng hỗ trợ.", when: "Dùng khi tích hợp thư viện OIDC để tự động cấu hình." },
  authorizeOidc: { summary: "Mở trang đăng nhập để người dùng cấp quyền cho ứng dụng.", when: "Dùng cho luồng đăng nhập trình duyệt với authorization code và PKCE." },
  issueOidcToken: { summary: "Đổi mã ủy quyền hoặc thông tin client lấy access token.", when: "Dùng ở máy chủ ứng dụng để lấy token trước khi gọi API." },
  getOidcKeys: { summary: "Công bố khóa công khai để kiểm tra chữ ký token.", when: "Dùng khi dịch vụ cần tự xác minh JWT mà không gọi lại Identity." },
  getOidcUserInfo: { summary: "Trả hồ sơ người dùng gắn với access token hiện tại.", when: "Dùng khi cần tên, email hoặc thông tin hồ sơ của người đang đăng nhập." },
  postOidcUserInfo: { summary: "Trả hồ sơ người dùng qua yêu cầu POST có token.", when: "Dùng khi client cần gửi token trong thân yêu cầu thay vì tiêu đề." },
  logoutOidc: { summary: "Kết thúc phiên đăng nhập tại Identity provider.", when: "Dùng khi người dùng đăng xuất khỏi ứng dụng web dùng OIDC." },
  browserLogoutOidc: { summary: "Chuyển trình duyệt tới trang đăng xuất của Identity provider.", when: "Dùng cho luồng đăng xuất bằng điều hướng trình duyệt." },
  createApplication: { summary: "Đề xuất đăng ký một ứng dụng mới vào tổ chức.", when: "Dùng khi đưa phần mềm mới vào Junctura; cần một người khác duyệt." },
  getApplication: { summary: "Đọc thông tin một ứng dụng mà bạn được xem.", when: "Dùng để kiểm tra trạng thái, đơn vị và cấu hình của ứng dụng." },
  approveApplication: { summary: "Kích hoạt một ứng dụng đang chờ và đã được duyệt độc lập.", when: "Dùng khi quản trị viên khác xác nhận yêu cầu đăng ký." },
  setApplicationState: { summary: "Tạm ngưng, bật lại hoặc thu hồi vĩnh viễn một ứng dụng.", when: "Dùng khi cần chặn ứng dụng hoặc kết thúc vòng đời của nó." },
  createApplicationApproval: { summary: "Tạo quyết định phê duyệt hoặc từ chối độc lập.", when: "Dùng khi cần ghi nhận người thứ hai đồng ý với một thay đổi quan trọng." },
  getApplicationApproval: { summary: "Đọc một quyết định phê duyệt đã ghi nhận.", when: "Dùng để kiểm tra ai đã duyệt, duyệt việc gì và còn hiệu lực không." },
  revokeApplicationApproval: { summary: "Thu hồi hiệu lực của một phê duyệt đã tạo.", when: "Dùng khi phát hiện phê duyệt sai hoặc cần giảm quyền đã cấp." },
  v1ListRecords: { summary: "Liệt kê bản ghi trong bộ dữ liệu bằng API v1 cũ.", when: "Dùng cho client cũ đã được cấu hình dùng tài nguyên v1." },
  v1CreateRecord: { summary: "Tạo bản ghi mới trong bộ dữ liệu bằng API v1.", when: "Dùng khi client cũ cần thêm dữ liệu có cấu trúc." },
  v1GetRecord: { summary: "Đọc một bản ghi cụ thể bằng API v1.", when: "Dùng khi client cũ cần lấy chi tiết một bản ghi." },
  v1ReplaceRecordData: { summary: "Thay dữ liệu của một bản ghi bằng API v1.", when: "Dùng khi client cũ cần cập nhật nội dung bản ghi." },
  v1DeleteRecord: { summary: "Xóa một bản ghi bằng API v1.", when: "Dùng khi client cũ cần loại bỏ dữ liệu không còn dùng." },
  v1UploadObject: { summary: "Tải tệp lên kho bằng API v1 cũ.", when: "Dùng cho client cũ cần gửi tệp nhị phân lên hệ thống." },
  v1PutObject: { summary: "Ghi đè nội dung một tệp bằng API v1.", when: "Dùng khi client cũ cần thay toàn bộ nội dung tệp đã có." },
  v1DownloadObject: { summary: "Tải nội dung một tệp bằng API v1.", when: "Dùng khi client cũ cần lấy tệp nhị phân." },
  v1DeleteObject: { summary: "Xóa một tệp bằng API v1.", when: "Dùng khi client cũ cần loại bỏ tệp không còn dùng." },
  v2ListRecords: { summary: "Liệt kê bản ghi trong không gian dữ liệu của chính ứng dụng.", when: "Dùng khi ứng dụng cần duyệt danh sách dữ liệu mình sở hữu." },
  v2CreateRecord: { summary: "Tạo bản ghi mới trong không gian dữ liệu riêng.", when: "Dùng khi ứng dụng cần lưu dữ liệu có cấu trúc." },
  v2GetRecord: { summary: "Đọc một bản ghi riêng hoặc được chia sẻ.", when: "Dùng khi ứng dụng cần xem chi tiết một bản ghi." },
  v2ReplaceRecordData: { summary: "Cập nhật dữ liệu một bản ghi riêng.", when: "Dùng khi ứng dụng cần sửa nội dung bản ghi đã lưu." },
  v2DeleteRecord: { summary: "Xóa một bản ghi trong không gian dữ liệu riêng.", when: "Dùng khi ứng dụng cần loại bỏ bản ghi vĩnh viễn." },
  v2UploadObject: { summary: "Tải tệp lên kho riêng của ứng dụng; tệp được quét mã độc.", when: "Dùng khi ứng dụng cần lưu tệp nhị phân an toàn." },
  v2PutObject: { summary: "Ghi đè nội dung một tệp riêng của ứng dụng.", when: "Dùng khi ứng dụng cần thay toàn bộ nội dung tệp đã có." },
  v2DownloadObject: { summary: "Tải nội dung một tệp riêng hoặc được chia sẻ.", when: "Dùng khi ứng dụng cần lấy tệp nhị phân." },
  v2DeleteObject: { summary: "Xóa một tệp trong kho riêng của ứng dụng.", when: "Dùng khi ứng dụng cần loại bỏ tệp vĩnh viễn." },
  createReadShare: { summary: "Chia sẻ chỉ đọc một bản ghi hoặc tệp cho ứng dụng khác.", when: "Dùng khi cần cho ứng dụng khác đọc một tài nguyên trong thời hạn." },
  revokeReadShare: { summary: "Thu hồi một chia sẻ chỉ đọc đã tạo.", when: "Dùng khi không muốn ứng dụng nhận tiếp tục đọc tài nguyên." },
  listWorkflowDefinitions: { summary: "Liệt kê các định nghĩa quy trình đã cài.", when: "Dùng để biết tổ chức có những quy trình nào trước khi khởi chạy." },
  startWorkflow: { summary: "Khởi chạy một lượt quy trình với khóa chống chạy trùng.", when: "Dùng khi cần bắt đầu một quy trình nghiệp vụ có nhiều bước." },
  getWorkflow: { summary: "Xem trạng thái và bước hiện tại của một lượt chạy.", when: "Dùng để theo dõi tiến độ hoặc kiểm tra quy trình đã xong chưa." },
  cancelWorkflow: { summary: "Hủy một lượt chạy quy trình đang xử lý.", when: "Dùng khi quy trình không còn cần thiết hoặc bị dừng theo yêu cầu." },
  completeWorkflow: { summary: "Hoàn thành bước hiện tại của một lượt chạy.", when: "Dùng khi bước đang chờ đã được xử lý xong và cần đi tiếp." },
  discoverCapabilities: { summary: "Liệt kê các phiên bản năng lực đã công bố mà bạn có quyền thấy.", when: "Dùng để tìm năng lực phù hợp trước khi đề xuất quyền." },
  registerCapabilityVersion: { summary: "Tạo bản nháp phiên bản mới cho một năng lực.", when: "Dùng khi bên cung cấp cần khai báo hợp đồng năng lực mới." },
  getCapabilityVersion: { summary: "Đọc một phiên bản năng lực cụ thể.", when: "Dùng để xem hợp đồng, trạng thái và thông tin của một phiên bản." },
  replaceCapabilityDraft: { summary: "Thay nội dung bản nháp; bản đã công bố không sửa được.", when: "Dùng khi cần chỉnh hợp đồng trước khi công bố phiên bản." },
  validateCapabilityVersion: { summary: "Kiểm tra hợp đồng đầu vào và đầu ra của phiên bản.", when: "Dùng trước khi công bố để phát hiện lỗi hợp đồng." },
  publishCapabilityVersion: { summary: "Công bố một phiên bản năng lực đã kiểm tra.", when: "Dùng khi bên cung cấp sẵn sàng cho ứng dụng khác gọi năng lực." },
  deprecateCapabilityVersion: { summary: "Ngừng khuyến nghị một phiên bản nhưng vẫn giữ dùng được.", when: "Dùng khi có phiên bản mới và muốn hướng người dùng chuyển sang." },
  revokeCapabilityVersion: { summary: "Thu hồi một phiên bản năng lực đã công bố.", when: "Dùng khi phiên bản có lỗi hoặc không còn được phép sử dụng." },
  proposeTrustGrant: { summary: "Đề xuất cho một ứng dụng gọi năng lực của ứng dụng khác.", when: "Dùng khi bên cung cấp muốn cấp quyền có mục đích và hạn dùng." },
  getTrustGrant: { summary: "Đọc thông tin một quyền giữa hai ứng dụng.", when: "Dùng để kiểm tra phạm vi, mục đích và hạn dùng của quyền." },
  activateTrustGrant: { summary: "Kích hoạt quyền sau khi quản trị viên khác duyệt.", when: "Dùng khi quyền đã được đề xuất và cần người thứ hai phê duyệt." },
  revokeTrustGrant: { summary: "Thu hồi quyền ngay lập tức.", when: "Dùng khi cần chặn ứng dụng gọi năng lực ở lần tiếp theo." },
  getTrustGraph: { summary: "Trả sơ đồ ứng dụng và quyền trong tổ chức.", when: "Dùng để rà soát ai đang được gọi năng lực nào." },
  createDelegation: { summary: "Người dùng tạo ủy quyền một bước, phạm vi hẹp cho người khác.", when: "Dùng khi cần chuyển tạm một quyền cụ thể mà không mở rộng phạm vi." },
  getDelegation: { summary: "Đọc thông tin một ủy quyền.", when: "Dùng để kiểm tra người nhận, phạm vi và thời hạn ủy quyền." },
  revokeDelegation: { summary: "Thu hồi một ủy quyền.", when: "Dùng khi người gốc hoặc quản trị viên muốn chấm dứt ủy quyền." },
  reauthorizeDelegation: { summary: "Người gốc làm mới bằng chứng mà không mở rộng phạm vi.", when: "Dùng khi ủy quyền cần xác nhận lại nhưng giữ nguyên thời hạn." },
  registerComposition: { summary: "Tạo quy trình ghép nhiều năng lực do ứng dụng gọi sở hữu.", when: "Dùng khi cần phối hợp nhiều năng lực thành một luồng xử lý." },
  registerCompositionVersion: { summary: "Thêm bản nháp phiên bản mới cho quy trình ghép.", when: "Dùng khi quy trình ghép cần thay đổi có phiên bản rõ ràng." },
  getCompositionVersion: { summary: "Đọc một phiên bản quy trình ghép cụ thể.", when: "Dùng để xem định nghĩa và trạng thái của quy trình ghép." },
  replaceCompositionDraft: { summary: "Thay nội dung bản nháp quy trình ghép.", when: "Dùng khi cần chỉnh quy trình trước khi công bố." },
  validateCompositionVersion: { summary: "Kiểm tra hợp đồng của một phiên bản quy trình ghép.", when: "Dùng trước khi công bố để chắc các bước nối đúng." },
  publishCompositionVersion: { summary: "Công bố phiên bản quy trình ghép.", when: "Dùng khi quy trình ghép đã sẵn sàng để chạy thật." },
  deprecateCompositionVersion: { summary: "Ngừng khuyến nghị một phiên bản quy trình ghép.", when: "Dùng khi có phiên bản mới thay thế." },
  revokeCompositionVersion: { summary: "Thu hồi một phiên bản quy trình ghép.", when: "Dùng khi phiên bản không còn được phép chạy." },
  createCapabilityExecution: { summary: "Nhận một lượt gọi năng lực có kiểm soát và ghim phiên bản.", when: "Dùng khi ứng dụng cần gọi một năng lực đã được cấp quyền." },
  getCapabilityExecution: { summary: "Đọc trạng thái một lượt gọi năng lực.", when: "Dùng để theo dõi kết quả hoặc kiểm tra lượt gọi đã xong chưa." },
  cancelCapabilityExecution: { summary: "Yêu cầu dừng một lượt gọi; không hoàn tác tác dụng đã phát.", when: "Dùng khi lượt gọi không còn cần thiết." },
  resumeCapabilityExecution: { summary: "Người khởi tạo gửi bằng chứng OIDC mới để tiếp tục lượt gọi.", when: "Dùng khi lượt gọi tạm dừng và cần xác nhận lại danh tính." },
  redeemProviderAuthorization: { summary: "Bên cung cấp đổi vé ủy quyền dùng một lần trước khi xử lý.", when: "Dùng trong bước xác nhận cuối của bên cung cấp khi nhận lời gọi." },
  listCapabilityAuditEvents: { summary: "Đọc sự kiện kiểm toán trong tổ chức khi có quyền audit.read.", when: "Dùng để tra cứu ai đã làm gì và khi nào." },
  verifyAuditChain: { summary: "Niêm phong sự kiện chờ và kiểm tra toàn vẹn chuỗi băm.", when: "Dùng định kỳ hoặc khi nghi ngờ nhật ký bị sửa." },
  getSubjectAccessLog: { summary: "Liệt kê các lượt gọi năng lực liên quan tới người đang đăng nhập.", when: "Dùng để người dân xem ai đã truy cập dữ liệu của mình." },
  listSubjectConsents: { summary: "Liệt kê các đồng ý của người đang đăng nhập.", when: "Dùng để xem ứng dụng nào đang được phép dùng dữ liệu của mình." },
  createSubjectConsent: { summary: "Cho phép một ứng dụng dùng dữ liệu của chính mình.", when: "Dùng khi người dân đồng ý cho một mục đích và thời hạn cụ thể." },
  revokeSubjectConsent: { summary: "Rút lại một đồng ý đã cấp.", when: "Dùng khi người dân không muốn ứng dụng tiếp tục dùng dữ liệu." },
  listEmergencyAccesses: { summary: "Liệt kê các lượt truy cập khẩn cấp cần hậu kiểm.", when: "Dùng khi quản trị viên cần rà soát truy cập không có đồng ý trước." },
  reviewEmergencyAccess: { summary: "Ghi kết quả hậu kiểm một lượt truy cập khẩn cấp.", when: "Dùng sau khi kiểm tra lý do và phạm vi của lượt truy cập khẩn cấp." },
};
